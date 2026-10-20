import itertools
import json
import queue
import threading
import time
import traceback

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import pipeline

app = FastAPI()
jobs: dict[str, dict] = {}  # key: "<video id>:<model>"
lock = threading.Lock()     # endpoints run in a thread pool; guard `jobs` and result.json writes
work: queue.Queue[tuple[str, str, str]] = queue.Queue()
order = itertools.count(1)  # FIFO ticket per job, for an honest queue position


def worker():
    # One job at a time: separation saturates the CPU anyway.
    while True:
        key, url, model = work.get()
        job = jobs[key]
        if job["stage"] == "cancelled":
            continue
        job["stage"], job["stageStarted"] = "starting", time.time()

        def report(stage, progress, **info):
            if stage != job.get("stage"):
                job["stageStarted"] = time.time()
            job.update(info, stage=stage, progress=progress)

        try:
            job["result"] = pipeline.process(url, model, report)
            job["title"] = job["result"]["title"]
            job["stage"], job["finished"] = "done", time.time()
        except BaseException as e:  # never let the worker die: queued jobs would wait forever
            traceback.print_exc()
            job["stage"], job["error"] = "error", str(e) or e.__class__.__name__


pipeline.DATA.mkdir(exist_ok=True)
pipeline.migrate_legacy()
threading.Thread(target=worker, daemon=True).start()


class JobIn(BaseModel):
    url: str
    model: str = pipeline.DEFAULT_MODEL
    title: str | None = None  # known from search results, so the queue can show it before download


_search_cache: dict[str, tuple[float, list]] = {}


@app.get("/api/search")
def search(q: str):
    q = q.strip()
    if not q:
        return []
    key = q.lower()
    hit = _search_cache.get(key)
    if not hit or time.time() - hit[0] > 3600:
        try:
            hit = (time.time(), pipeline.search(q))
        except Exception as e:
            raise HTTPException(502, f"YouTube search failed: {str(e)[:200]}")
        _search_cache[key] = hit
        if len(_search_cache) > 200:
            _search_cache.pop(next(iter(_search_cache)))
    in_library = {p.parent.name: pipeline.available_stems(p.parent) for p in pipeline.DATA.glob("*/result.json")}
    return [{**r, "stems": in_library.get(r["id"], [])} for r in hit[1]]


@app.get("/api/models")
def models():
    return {"default": pipeline.DEFAULT_MODEL,
            "models": [{"key": k, **{f: v[f] for f in ("name", "desc", "speed")}}
                       for k, v in pipeline.SEPARATION_MODELS.items()]}


@app.post("/api/jobs")
def create_job(body: JobIn):
    vid = pipeline.video_id(body.url)
    if not vid:
        raise HTTPException(400, "That doesn't look like a YouTube link")
    if body.model not in pipeline.SEPARATION_MODELS:
        raise HTTPException(400, "Unknown separation model")
    key = f"{vid}:{body.model}"
    with lock:
        job = jobs.get(key)
        if job and job["stage"] not in ("error", "done", "cancelled"):
            return {"id": vid, "model": body.model}
        result = pipeline.load_result(vid)
        if result and body.model in result["stems"]:
            jobs[key] = {"stage": "done", "result": result, "id": vid, "model": body.model,
                         "title": result["title"], "finished": time.time()}
        else:
            jobs[key] = {"stage": "queued", "progress": None, "stageStarted": time.time(), "seq": next(order),
                         "id": vid, "model": body.model, "title": body.title}
            work.put((key, body.url, body.model))
    return {"id": vid, "model": body.model}


@app.get("/api/jobs")
def list_jobs():
    """The processing queue: everything waiting or running, plus what finished in the last 10 minutes."""
    now = time.time()
    with lock:
        out = []
        for j in jobs.values():
            if j["stage"] == "done" and now - j.get("finished", 0) > 600:
                continue
            if j["stage"] == "done" and j.get("seq") is None:
                continue  # opened from the library, never queued
            out.append({k: j.get(k) for k in ("id", "model", "title", "stage", "progress", "stageStarted",
                                               "seq", "error", "finished")})
    out.sort(key=lambda j: (j["stage"] == "done", j["stage"] == "error", j.get("seq") or 0))
    return {"now": now, "jobs": out}


@app.delete("/api/jobs/{vid}/{model}")
def dismiss_job(vid: str, model: str):
    """Remove a queued (not yet started) job, or clear a finished/failed one from the list."""
    with lock:
        job = jobs.get(f"{vid}:{model}")
        if not job:
            raise HTTPException(404)
        if job["stage"] == "queued":
            job["stage"], job["error"] = "cancelled", "Removed from the queue"
        elif job["stage"] in ("done", "error", "cancelled"):
            jobs.pop(f"{vid}:{model}")
        else:
            raise HTTPException(409, "Already processing; it can't be stopped halfway")
    return {"ok": True}


@app.get("/api/jobs/{vid}/{model}")
def get_job(vid: str, model: str):
    with lock:
        job = jobs.get(f"{vid}:{model}")
        if not job:
            raise HTTPException(404, "Job not found (the server may have restarted)")
        ahead = 0
        if job["stage"] == "queued":
            # Everything queued earlier, plus the one being processed right now.
            ahead = sum(1 for j in jobs.values()
                        if j is not job and j["stage"] not in ("done", "error", "cancelled")
                        and (j["stage"] != "queued" or j["seq"] < job["seq"]))
        snapshot = dict(job)
    return {"queuePos": ahead, "now": time.time(), **snapshot}


class OffsetIn(BaseModel):
    offset: float


@app.post("/api/songs/{vid}/offset")
def save_offset(vid: str, body: OffsetIn):
    """Remember a manually corrected lyric offset for next time."""
    path = pipeline.DATA / vid / "result.json"
    with lock:
        if not path.exists():
            raise HTTPException(404)
        data = json.loads(path.read_text(encoding="utf-8"))
        data["offset"] = round(body.offset, 2)
        pipeline.write_json(path, data)
        for key, job in list(jobs.items()):
            if key.startswith(vid + ":") and "result" in job:
                job["result"]["offset"] = data["offset"]
    return {"ok": True}


STATIC = pipeline.Path(__file__).parent / "static"


@app.get("/api/library")
def library():
    # Built-in songs first (freely licensed, shipped in static/songs/), then the user's own.
    items = []
    for p in sorted(STATIC.glob("songs/*/song.json")):
        d = json.loads(p.read_text(encoding="utf-8"))
        items.append({"id": d["id"], "artist": d["artist"], "title": d["title"], "stems": d["stems"],
                      "source": "bundled", "bundled": True})
    for p in sorted(pipeline.DATA.glob("*/result.json"), key=lambda p: -p.stat().st_mtime):
        try:
            d = pipeline.load_result(p.parent.name)
        except (OSError, ValueError):  # being written right now; it'll show up next time
            continue
        if d and d["stems"]:
            items.append({"id": d["id"], "artist": d["artist"], "title": d["title"], "stems": d["stems"],
                          "source": d["source"]})
    return items


app.mount("/media", StaticFiles(directory=pipeline.DATA), name="media")
app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")

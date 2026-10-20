"""Pipeline: YouTube URL -> instrumental + synced lyrics.

Stages: download (yt-dlp) -> separate (MDX-Net via audio-separator) -> lyrics (LRCLIB, Whisper fallback)
-> align (shift LRC timings to match the vocals in this particular video).
"""
from __future__ import annotations

import difflib
import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Callable

import httpx
import imageio_ffmpeg
import numpy as np
import soundfile as sf

# The desktop app installs the code read-only and points these at the user's app-data folder.
_HERE = Path(__file__).parent
DATA = Path(os.environ.get("STAGELIGHT_DATA") or _HERE / "data")

# audio-separator / pydub look for a plain "ffmpeg" on PATH. Use the system one if there is one,
# otherwise expose the binary bundled with imageio-ffmpeg under that name.
_BIN = Path(os.environ.get("STAGELIGHT_BIN") or _HERE / "bin")
FFMPEG = shutil.which("ffmpeg")
if not FFMPEG:
    FFMPEG = str(_BIN / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg"))
    if not Path(FFMPEG).exists():
        _BIN.mkdir(parents=True, exist_ok=True)
        shutil.copy(imageio_ffmpeg.get_ffmpeg_exe(), FFMPEG)
    os.environ["PATH"] = str(_BIN) + os.pathsep + os.environ.get("PATH", "")
SR = 44100

Report = Callable[..., None]  # (stage, progress 0..1 or None, **extra info such as title)

_ID_RE = re.compile(r"(?:v=|youtu\.be/|shorts/|embed/|live/)([A-Za-z0-9_-]{11})")


def video_id(url: str) -> str | None:
    url = url.strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", url):
        return url
    m = _ID_RE.search(url)
    return m.group(1) if m else None


# ---------------------------------------------------------------- download & search

MAX_DURATION = 900  # 15 min: longer videos are mixes or livestreams, not songs


def _js_runtimes() -> dict:
    # YouTube needs a JavaScript runtime to solve its player challenges; use whichever is installed.
    # The desktop app ships one (Electron runs as Node with ELECTRON_RUN_AS_NODE=1). Prefer it: a
    # system Node may be older than the version yt-dlp requires.
    if os.environ.get("STAGELIGHT_NODE"):
        return {"node": {"path": os.environ["STAGELIGHT_NODE"]}}
    return {name: {} for name in ("deno", "node", "bun") if shutil.which(name)}


def search(query: str, limit: int = 12) -> list[dict]:
    """YouTube search through yt-dlp: no API key needed. Flat extraction, so it takes 1-3 s."""
    import yt_dlp

    opts = {"quiet": True, "no_warnings": True, "skip_download": True, "extract_flat": "in_playlist"}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"ytsearch{limit * 2}:{query}", download=False)
    results = []
    for e in info.get("entries") or []:
        vid, dur = e.get("id"), e.get("duration")
        if not vid or len(vid) != 11 or e.get("live_status") in ("is_live", "is_upcoming"):
            continue
        if dur and dur > MAX_DURATION:
            continue
        results.append({"id": vid, "title": e.get("title") or "", "channel": e.get("channel") or e.get("uploader") or "",
                        "duration": dur})
        if len(results) == limit:
            break
    return results


def download(vid: str, out: Path, report: Report) -> dict:
    import yt_dlp

    def hook(d):
        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            if total:
                report("download", d.get("downloaded_bytes", 0) / total)

    opts = {
        "format": "bestaudio/best",
        "outtmpl": str(out / "source.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "ffmpeg_location": FFMPEG,
        "progress_hooks": [hook],
        "retries": 5,
        "socket_timeout": 20,
        # A 3-hour mix or a livestream would hold the single worker for hours.
        "match_filter": yt_dlp.utils.match_filter_func(f"duration < {MAX_DURATION} & !is_live"),
    }
    runtimes = _js_runtimes()
    if runtimes:
        opts["js_runtimes"] = runtimes
        opts["remote_components"] = {"ejs:github"}
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={vid}", download=True)
            src = Path(ydl.prepare_filename(info)) if info else None
        if not src or not src.exists():  # skipped by match_filter
            raise ValueError("Videos longer than 15 minutes and livestreams aren't supported")
    except yt_dlp.utils.DownloadError as e:
        msg = str(e).replace("ERROR: ", "")
        hint = "" if runtimes else " (install Node.js or Deno: YouTube needs a JavaScript runtime)"
        raise ValueError(f"Couldn't download from YouTube: {msg[:200]}{hint}") from e

    tmp = out / "mix.tmp.wav"
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", str(src), "-ac", "2", "-ar", str(SR),
                    "-c:a", "pcm_f32le", str(tmp)], check=True)
    tmp.replace(out / "mix.wav")
    # Keep the downloaded file so other models separate from it, not from a re-encode.
    src.replace(out / f"original{src.suffix}")
    return {
        "title": info.get("title") or "",
        "track": info.get("track"),
        "artist": info.get("artist") or info.get("creator"),
        "channel": info.get("channel") or info.get("uploader") or "",
        "duration": info.get("duration") or 0,
    }


# ---------------------------------------------------------------- separation

# Timings from a 30 s clip on a 4-core laptop CPU: KARA_2 and 9482 ~85 s, Inst_HQ_3 ~130 s.
# overlap 0.1 (default 0.25) is ~20% faster with no audible seams.
SEPARATION_MODELS = {
    "karaoke": {"file": "UVR_MDXNET_KARA_2.onnx", "name": "Karaoke",
                "desc": "Removes the lead vocal, keeps backing vocals.", "speed": "Fast"},
    "clean": {"file": "UVR_MDXNET_9482.onnx", "name": "Clean instrumental",
              "desc": "Removes every vocal, including harmonies.", "speed": "Fast"},
    "hq": {"file": "UVR-MDX-NET-Inst_HQ_3.onnx", "name": "High quality",
           "desc": "Cleanest instrumental with fewer artefacts.", "speed": "Slow"},
}
DEFAULT_MODEL = "karaoke"
MDX_PARAMS = {"hop_length": 1024, "segment_size": 256, "overlap": 0.1, "batch_size": 1, "enable_denoise": False}
MODEL_DIR = Path(os.environ.get("STAGELIGHT_MODELS") or _HERE / "models")
_separator = None
_loaded_model = None


def separate(mix: Path, stems: Path, model_key: str, report: Report) -> None:
    report("separate", None)  # before the imports: they alone take a few seconds
    import logging
    import tempfile

    import audio_separator.separator.architectures.mdx_separator as mdx
    import audio_separator.separator.architectures.mdxc_separator as mdxc
    from audio_separator.separator import Separator

    global _separator, _loaded_model
    if _separator is None:
        _separator = Separator(log_level=logging.WARNING, model_file_dir=str(MODEL_DIR),
                               output_format="WAV", mdx_params=MDX_PARAMS)
    if _loaded_model != model_key:
        _separator.load_model(model_filename=SEPARATION_MODELS[model_key]["file"])  # downloads on first use
        _loaded_model = model_key

    # The models loop over chunks with tqdm; swap it for one that feeds our progress bar.
    # Some models make a second, shorter pass: give it the remaining part of the bar, so the
    # percentage never jumps backwards.
    state = {"done": 0.0}

    def progress(iterable, *args, **kwargs):
        items = list(iterable)
        start = state["done"]
        span = 1.0 if start == 0 else (1.0 - start) * 0.8
        for i, item in enumerate(items):
            report("separate", min(0.99, start + span * i / len(items)))
            yield item
        state["done"] = min(0.99, start + span)

    mdx.tqdm = mdxc.tqdm = progress

    # A fresh folder per run, so a crashed earlier run can never hand us its leftovers.
    work = Path(tempfile.mkdtemp(prefix="sep-", dir=mix.parent))
    try:
        _separator.output_dir = _separator.model_instance.output_dir = str(work)
        names = {"Vocals": "vocals", "Instrumental": "instrumental", "Other": "instrumental"}
        files = [work / Path(f).name for f in _separator.separate(str(mix), names)]
        vocal = next((f for f in files if "vocal" in f.stem.lower()), None)
        inst = next((f for f in files if f != vocal), None)
        if not vocal or not inst:
            raise RuntimeError(f"Separation produced unexpected files: {[f.name for f in files]}")

        report("encode", None)
        stems.mkdir(parents=True, exist_ok=True)
        # instrumental.mp3 marks the model as done, so it is written last and atomically.
        encode_mp3(vocal, stems / "vocals.mp3")
        vocal.replace(stems / "vocals.wav")  # kept for alignment / Whisper
        encode_mp3(inst, stems / "instrumental.mp3")
    finally:
        shutil.rmtree(work, ignore_errors=True)


def encode_mp3(src: Path, dest: Path, bitrate: str = "192k") -> None:
    tmp = dest.with_name(dest.stem + ".tmp.mp3")
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", str(src), "-b:a", bitrate, str(tmp)], check=True)
    tmp.replace(dest)


def available_stems(out: Path) -> list[str]:
    return [k for k in SEPARATION_MODELS
            if (out / "stems" / k / "instrumental.mp3").exists() and (out / "stems" / k / "vocals.mp3").exists()]


def write_json(path: Path, data: dict) -> None:
    """Write via a temp file so a concurrent reader never sees half a document."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    for attempt in range(5):
        try:
            tmp.replace(path)
            return
        except PermissionError:  # Windows: the file may be open in another thread for a moment
            time.sleep(0.05 * (attempt + 1))
    tmp.replace(path)


# ---------------------------------------------------------------- lyrics

_JUNK = re.compile(
    r"[\(\[][^\)\]]*\b(official|video|audio|lyrics?|clip|hd|4k|remaster(ed)?|teledysk|visuali[sz]er|live|"
    r"mv|m/v|music)\b[^\)\]]*[\)\]]",
    re.I,
)
_FEAT = re.compile(r"\s*[\(\[]?\b(feat|ft|featuring)\b\.?\s.*$", re.I)


def guess_artist_title(meta: dict) -> tuple[str, str]:
    if meta.get("artist") and meta.get("track"):
        return re.split(r",|&| x ", meta["artist"])[0].strip(), meta["track"].strip()
    title = re.sub(r"\s{2,}", " ", _JUNK.sub("", meta["title"])).strip(" -|")
    for sep in (" - ", " – ", " — ", " | "):
        if sep in title:
            a, t = title.split(sep, 1)
            # Strip "feat. X" per side, so "Artist ft. X - Song" keeps the song title.
            return _FEAT.sub("", a).strip(), _FEAT.sub("", t).strip(" -|\"'")
    channel = re.sub(r"(VEVO|\s*-\s*Topic|Official)$", "", meta["channel"], flags=re.I).strip()
    return channel, _FEAT.sub("", title).strip("\"'")


def _similar(a: str, b: str) -> float:
    norm = lambda s: re.sub(r"[^\w]+", " ", (s or "").lower()).strip()
    return difflib.SequenceMatcher(None, norm(a), norm(b)).ratio()


def fetch_lrclib(artist: str, title: str, duration: float) -> dict | None:
    headers = {"User-Agent": "Stagelight karaoke (https://github.com/bartoszkolo/stagelight)"}
    api = "https://lrclib.net/api"
    with httpx.Client(timeout=15, headers=headers) as c:
        # Exact lookup first (matches duration within ~2 s), then progressively looser searches.
        r = c.get(f"{api}/get", params={"artist_name": artist, "track_name": title, "duration": round(duration)})
        if r.status_code == 200 and r.json().get("syncedLyrics"):
            return r.json()
        results = []
        for params in ({"artist_name": artist, "track_name": title}, {"track_name": title},
                       {"q": f"{artist} {title}"}):
            r = c.get(f"{api}/search", params=params)
            if r.status_code == 200:
                results = [x for x in r.json() if x.get("syncedLyrics") and not x.get("instrumental")]
            if results:
                break

    def score(x):
        s = 2 * _similar(x.get("trackName"), title) + _similar(x.get("artistName"), artist)
        d = (x.get("duration") or 0) - duration
        # Music videos are often longer than the album track (intros, outros), rarely shorter.
        s -= 0.02 * max(0, abs(d) - 3) * (0.5 if d < 0 else 1.5)
        return s

    results = [x for x in results if _similar(x.get("trackName"), title) > 0.5]
    return max(results, key=score) if results else None


_TS = re.compile(r"\[(\d+):(\d+)(?:[.:](\d+))?\]")
_OFFSET = re.compile(r"\[offset:\s*([+-]?\d+)\]", re.I)


def parse_lrc(lrc: str) -> list[dict]:
    m = _OFFSET.search(lrc)
    shift = -int(m.group(1)) / 1000 if m else 0.0  # positive [offset] means lyrics come sooner
    lines = []
    for raw in lrc.splitlines():
        stamps = _TS.findall(raw)
        text = _TS.sub("", raw).strip()
        for mm, ss, frac in stamps:
            t = int(mm) * 60 + int(ss) + (int(frac) / 10 ** len(frac) if frac else 0)
            lines.append({"t": max(0.0, t + shift), "text": text})
    lines.sort(key=lambda x: x["t"])
    for i, ln in enumerate(lines):
        nxt = lines[i + 1]["t"] if i + 1 < len(lines) else ln["t"] + 5
        ln["end"] = min(nxt, ln["t"] + max(2.0, 0.35 * len(ln["text"].split()) + 1.5))
    return [ln for ln in lines if ln["text"]]


_whisper = None


def transcribe(vocals: Path, report: Report) -> list[dict]:
    from faster_whisper import WhisperModel

    global _whisper
    report("transcribe", None)
    if _whisper is None:
        _whisper = WhisperModel("small", device="cpu", compute_type="int8")
    # Decode ourselves (16 kHz mono float) instead of handing Whisper a path: its own decoder goes
    # through PyAV, whose API changed under it (PyAV 19 dropped an argument faster-whisper passes).
    pcm = subprocess.run([FFMPEG, "-loglevel", "error", "-i", str(vocals), "-ac", "1", "-ar", "16000",
                          "-f", "f32le", "pipe:1"], check=True, capture_output=True).stdout
    audio = np.frombuffer(pcm, dtype="<f4").copy()

    def run(vad: bool) -> list[dict]:
        segments, info = _whisper.transcribe(audio, word_timestamps=True,
                                             vad_filter=vad, condition_on_previous_text=False)
        lines = []
        for seg in segments:
            report("transcribe", min(0.99, seg.end / max(info.duration, 1)))
            words = [{"t": w.start, "end": w.end, "w": w.word.strip()} for w in (seg.words or [])]
            if words:
                lines.append({"t": words[0]["t"], "end": words[-1]["end"],
                              "text": " ".join(w["w"] for w in words), "words": words})
        return lines

    # The voice-activity filter is tuned for speech and can discard sung (or synthesized) vocals
    # entirely; if it leaves nothing, listen to the whole stem.
    return run(vad=True) or run(vad=False)


# ---------------------------------------------------------------- alignment

def vocal_envelope(path: Path, hz: int = 10) -> np.ndarray:
    audio, sr = sf.read(path, dtype="float32", always_2d=True)
    mono = audio.mean(1)
    hop = sr // hz
    frames = mono[: len(mono) // hop * hop].reshape(-1, hop)
    env = np.sqrt((frames ** 2).mean(1))
    p95 = np.percentile(env, 95) or 1.0
    return np.clip(env / p95, 0, 1)


def best_offset(lines: list[dict], env: np.ndarray, hz: int = 10) -> float:
    """Shift (seconds) to add to LRC times so lyric lines overlap sung vocals the most."""
    n = len(env)
    v = env - env.mean()
    best, best_score = 0.0, -np.inf
    for step in range(-30 * hz, 120 * hz + 1):
        off = step / hz
        mask = np.zeros(n, dtype=np.float32)
        for ln in lines:
            a, b = int((ln["t"] + off) * hz), int((ln["end"] + off) * hz)
            if b > 0 and a < n:
                mask[max(a, 0): min(b, n)] = 1
        score = float((v * (mask - mask.mean())).sum()) - 0.02 * abs(off)  # mild prior for 0
        if score > best_score:
            best, best_score = off, score
    return round(best, 2)


# ---------------------------------------------------------------- orchestration

def migrate_legacy() -> None:
    """Songs made before model selection kept their stems at the top level (made with Inst_HQ_3).

    Called once at startup, before any request can read the files."""
    for out in DATA.glob("*"):
        if (out / "instrumental.mp3").exists():
            dest = out / "stems" / "hq"
            dest.mkdir(parents=True, exist_ok=True)
            for name in ("instrumental.mp3", "vocals.mp3", "vocals.wav"):
                if (out / name).exists():
                    (out / name).replace(dest / name)
    for tmp in DATA.glob("*/sep-*"):  # work folders left by a crash mid-separation
        shutil.rmtree(tmp, ignore_errors=True)


def load_result(vid: str) -> dict | None:
    path = DATA / vid / "result.json"
    if not path.exists():
        return None
    result = json.loads(path.read_text(encoding="utf-8"))
    result["stems"] = available_stems(DATA / vid)
    return result


def _original(out: Path) -> Path | None:
    return next((p for p in out.glob("original.*") if ".tmp" not in p.name), None)


def process(url: str, model_key: str, report: Report) -> dict:
    vid = video_id(url)
    if not vid:
        raise ValueError("That doesn't look like a YouTube link")
    if model_key not in SEPARATION_MODELS:
        raise ValueError(f"Unknown separation model: {model_key}")
    out = DATA / vid
    out.mkdir(parents=True, exist_ok=True)
    stems = out / "stems" / model_key
    result_path = out / "result.json"
    meta_path = out / "meta.json"
    mix = out / "mix.wav"
    done = lambda: model_key in available_stems(out)

    if done() and result_path.exists():
        return load_result(vid)

    if meta_path.exists():
        report("download", None, title=json.loads(meta_path.read_text(encoding="utf-8"))["title"])
    if not meta_path.exists() or not (mix.exists() or _original(out) or done()):
        report("download", 0)
        write_json(meta_path, download(vid, out, report))
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    report("download", 1, title=meta["title"])

    if not done():
        if not mix.exists():  # separating with another model: decode the kept original
            tmp = out / "mix.tmp.wav"
            subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", str(_original(out)), "-ac", "2",
                            "-ar", str(SR), "-c:a", "pcm_f32le", str(tmp)], check=True)
            tmp.replace(mix)
        separate(mix, stems, model_key, report)
        mix.unlink(missing_ok=True)

    if result_path.exists():  # lyrics don't depend on the model
        return load_result(vid)

    vocals = stems / "vocals.wav"
    report("lyrics", None)
    artist, title = guess_artist_title(meta)
    found = None
    try:
        found = fetch_lrclib(artist, title, meta["duration"])
    except httpx.HTTPError:
        pass

    offset = 0.0
    if found:
        lines = parse_lrc(found["syncedLyrics"])
        report("align", None)
        offset = best_offset(lines, vocal_envelope(vocals))
        source = "lrclib"
        artist, title = found.get("artistName") or artist, found.get("trackName") or title
    else:
        lines = transcribe(vocals, report)
        source = "whisper"

    result = {
        "id": vid, "artist": artist, "title": title, "videoTitle": meta["title"],
        "source": source, "offset": offset, "lines": lines,
    }
    write_json(result_path, result)
    return load_result(vid)

"""Turn a freely licensed song into one of Stagelight's built-in songs (static/songs/<slug>/).

    python tools/bundle_song.py --audio song.mp3 --lyrics lyrics.txt --slug crazy-glue \
        --title "Crazy Glue" --artist "Josh Woodward" --license "CC BY 4.0" \
        --credit "\"Crazy Glue\" by Josh Woodward, https://www.joshwoodward.com/song/CrazyGlue"

Only use material you're allowed to redistribute (public domain, CC0, CC BY...). The steps:
separate the lead vocal like the app does, transcribe the vocal with Whisper for word timings, then
lay the official lyric lines over those timings (sung repeats of a chorus get the text again).
"""
from __future__ import annotations

import argparse
import difflib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import pipeline  # noqa: E402

norm = lambda w: re.sub(r"[^\w']+", "", w.lower())
MAX_GAP = 2.5  # seconds of silence between two words that ends a line


def max_line_seconds(n_words: int) -> float:
    """Generous upper bound for singing n words; anything longer is a mis-alignment."""
    return 2.0 + 0.6 * n_words


def align(official: list[str], words: list[dict]) -> list[dict]:
    """Walk through the transcribed words and, at each point, find the official line that best
    matches the next few words. Lines can be reused, so a chorus sung three times shows up three
    times even when the lyrics sheet lists it once."""
    targets = [(line, [norm(w) for w in line.split()]) for line in official]
    heard = [norm(w["w"]) for w in words]
    out, i = [], 0
    while i < len(words):
        best = None
        for line, toks in targets:
            n = len(toks)
            for span in (n - 1, n, n + 1, n + 2):
                if span < 1 or i + span > len(words):
                    continue
                # One sung line never spans an instrumental break.
                if any(words[k + 1]["t"] - words[k]["end"] > MAX_GAP for k in range(i, i + span - 1)):
                    continue
                score = difflib.SequenceMatcher(None, toks, heard[i:i + span]).ratio()
                if best is None or score > best[0]:
                    best = (score, line, span)
        if best and best[0] >= 0.55:
            _, line, span = best
            seg = words[i:i + span]
            out.append(_place(line, seg))
            i += span
        else:
            i += 1  # an ad-lib or a mis-hearing: skip it
    return out


def _place(line: str, seg: list[dict]) -> dict:
    """Spread the official words over the time the singer took, following the heard word timings."""
    t0, t1 = seg[0]["t"], seg[-1]["end"]
    parts = line.split()
    if t1 - t0 > max_line_seconds(len(parts)):  # held note or stray word far away: cap it
        t1 = t0 + max_line_seconds(len(parts))
        seg = [w for w in seg if w["t"] < t1] or seg[:1]
    if len(parts) == len(seg):
        ws = [{"t": h["t"], "end": h["end"], "w": p} for p, h in zip(parts, seg)]
    else:
        total = sum(len(p) + 1 for p in parts)
        ws, t = [], t0
        for p in parts:
            d = (t1 - t0) * (len(p) + 1) / total
            ws.append({"t": round(t, 3), "end": round(t + d, 3), "w": p})
            t += d
    return {"t": round(t0, 3), "end": round(t1, 3), "text": line, "words": ws}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True, type=Path)
    ap.add_argument("--lyrics", required=True, type=Path, help="official lyrics, one line per sung line")
    ap.add_argument("--slug", required=True)
    ap.add_argument("--title", required=True)
    ap.add_argument("--artist", required=True)
    ap.add_argument("--license", required=True)
    ap.add_argument("--credit", required=True)
    ap.add_argument("--model", default=pipeline.DEFAULT_MODEL)
    a = ap.parse_args()

    out = ROOT / "static" / "songs" / a.slug
    out.mkdir(parents=True, exist_ok=True)
    report = lambda stage, p=None, **_: print(f"  {stage} {'' if p is None else f'{p:.0%}'}", end="\r", flush=True)

    work = Path(tempfile.mkdtemp(prefix="bundle-"))
    try:
        mix = work / "mix.wav"
        subprocess.run([pipeline.FFMPEG, "-y", "-loglevel", "error", "-i", str(a.audio), "-ac", "2",
                        "-ar", str(pipeline.SR), "-c:a", "pcm_f32le", str(mix)], check=True)
        print("separating…")
        pipeline.separate(mix, work, a.model, report)
        for stem in ("instrumental.mp3", "vocals.mp3"):
            shutil.copy(work / stem, out / stem)
        print("\ntranscribing…")
        heard = [w for line in pipeline.transcribe(work / "vocals.wav", report) for w in line["words"]]
    finally:
        shutil.rmtree(work, ignore_errors=True)

    official = [l.strip() for l in a.lyrics.read_text(encoding="utf-8").splitlines() if l.strip()]
    lines = align(official, heard)
    song = {
        "id": a.slug, "title": a.title, "artist": a.artist, "videoTitle": f"{a.artist} - {a.title}",
        "source": "bundled", "offset": 0, "stems": [a.model], "media": f"songs/{a.slug}",
        "bundled": True, "license": a.license, "credit": a.credit, "lines": lines,
    }
    (out / "song.json").write_text(json.dumps(song, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n{a.slug}: {len(heard)} words heard, {len(lines)} lines placed "
          f"({sum(1 for l in lines if l['words'])} with timings), first line at {lines[0]['t']:.1f}s" if lines else "no lines placed")


if __name__ == "__main__":
    main()

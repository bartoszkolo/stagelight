#!/usr/bin/env bash
# Builds stagelight.cc into site/dist: the landing page, plus the real player as a static demo at /demo/.
# Cloudflare Pages: build command `bash site/build.sh`, output directory `site/dist`.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf dist
mkdir -p dist/demo
cp index.html site.css site.js dist/
cp -r assets dist/
cp -r ../static/. dist/demo/

# Tell the player there's no server behind it (no search, queue or library on the website).
"${PYTHON:-python3}" - <<'PY'
from pathlib import Path
page = Path("dist/demo/index.html")
html = page.read_text(encoding="utf-8")
html = html.replace('<script src="app.js"></script>',
                    '<script>window.STAGELIGHT_STATIC = true</script>\n<script src="app.js"></script>')
html = html.replace("<title>Stagelight Karaoke</title>", "<title>Stagelight · Demo</title>")
page.write_text(html, encoding="utf-8")
PY

echo "Built $(find dist -type f | wc -l) files into site/dist"

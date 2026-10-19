#!/usr/bin/env bash
# Stagelight: start on macOS / Linux. The first run creates .venv and installs everything (a few minutes).
#   ./start.sh
set -euo pipefail
cd "$(dirname "$0")"
PY=.venv/bin/python
EXTRA=()
# Linux without an NVIDIA GPU: the CPU build of torch is ~10x smaller than the CUDA one.
if [[ "$(uname)" == "Linux" ]] && ! command -v nvidia-smi >/dev/null; then
  EXTRA=(--extra-index-url https://download.pytorch.org/whl/cpu)
fi

if [[ ! -x "$PY" ]]; then
  echo "First run: setting up Python environment..."
  if command -v uv >/dev/null; then
    uv venv --python 3.12 .venv
    uv pip install --python "$PY" -r requirements.txt "${EXTRA[@]}" --index-strategy unsafe-best-match
  else
    python3.12 -m venv .venv || python3 -m venv .venv
    "$PY" -m pip install --upgrade pip
    "$PY" -m pip install -r requirements.txt "${EXTRA[@]}"
  fi
fi

if ! command -v node >/dev/null && ! command -v deno >/dev/null; then
  echo "Tip: install Node.js or Deno. YouTube downloads need a JavaScript runtime."
fi

echo "Stagelight is running at http://localhost:8765 (Ctrl+C to stop)"
( sleep 3; (command -v open >/dev/null && open http://localhost:8765) || xdg-open http://localhost:8765 || true ) >/dev/null 2>&1 &
exec "$PY" -m uvicorn server:app --port 8765

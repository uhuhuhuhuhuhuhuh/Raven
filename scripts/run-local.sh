#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -x .venv/bin/python ]]; then
  echo "[RAVEN] Creating Python virtual environment..."
  python3 -m venv .venv
fi
.venv/bin/python -m pip install -q -r server/requirements.txt

if [[ ! -f frontend/dist/index.html ]]; then
  command -v npm >/dev/null || { echo "Node.js/npm is required to build the WebUI."; exit 1; }
  (cd frontend && npm install && npm run build)
fi

echo "[RAVEN] Local WebUI: http://127.0.0.1:8742"
exec .venv/bin/python -m uvicorn server.main:app --host 127.0.0.1 --port 8742

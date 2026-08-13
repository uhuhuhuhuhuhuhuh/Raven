$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not (Test-Path ".venv/Scripts/python.exe")) {
  Write-Host "[RAVEN] Creating Python virtual environment..."
  py -3 -m venv .venv
}

& .venv/Scripts/python.exe -m pip install -q -r server/requirements.txt

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "Node.js/npm is required to build the WebUI." }
Push-Location frontend
npm ci --no-audit --no-fund
npm run build
Pop-Location

Write-Host "[RAVEN] Local WebUI: http://127.0.0.1:8742"
Start-Process "http://127.0.0.1:8742"
& .venv/Scripts/python.exe -m uvicorn server.main:app --host 127.0.0.1 --port 8742

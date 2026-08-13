@echo off
setlocal
cd /d "%~dp0.."

if not exist ".venv\Scripts\python.exe" (
  echo [RAVEN] Creating Python virtual environment...
  py -3 -m venv .venv
  if errorlevel 1 exit /b 1
)

".venv\Scripts\python.exe" -m pip install -q -r server\requirements.txt
if errorlevel 1 exit /b 1

if not exist "frontend\dist\index.html" (
  where npm >nul 2>&1 || (echo [RAVEN] Node.js/npm is required to build the WebUI. & exit /b 1)
  pushd frontend
  call npm install
  if errorlevel 1 exit /b 1
  call npm run build
  if errorlevel 1 exit /b 1
  popd
)

echo [RAVEN] Local WebUI: http://127.0.0.1:8742
start "" http://127.0.0.1:8742
".venv\Scripts\python.exe" -m uvicorn server.main:app --host 127.0.0.1 --port 8742

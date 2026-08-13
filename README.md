# Raven

Raven is a map-first open-data awareness dashboard with one frontend and two deployment modes.

- **Raven Web** runs as a static GitHub Pages application. It uses browser-safe public APIs and local browser storage.
- **Raven Local** serves the same compiled WebUI from a Python/FastAPI process and adds server-side provider access, SQLite caching, and room for future local-only integrations.

Raven is designed around public/openly documented data. It does not probe private camera systems or bypass authentication.

## Current working features

- Tactical full-screen Raven dashboard
- MapLibre + OpenStreetMap basemap
- Search through OpenStreetMap Nominatim
- Browser geolocation
- Scan-radius control and range ring
- Contact register linked to map markers
- Camera classification summary
- Nearest-contact calculation
- Selected-contact metadata panel
- Heatmap toggle
- OpenStreetMap surveillance/speed-camera scan through Overpass
- Automatic `STATIC` vs `LOCAL` mode detection through `/api/health`
- FastAPI local API with SQLite response cache
- GitHub Pages deployment workflow
- Windows Batch, PowerShell, and Linux/macOS local launch scripts

## GitHub Pages mode

The workflow in `.github/workflows/pages.yml` builds `frontend/` with the `/Raven/` base path and deploys `frontend/dist` to GitHub Pages whenever `main` is updated.

For the repository's first Pages deployment, make sure GitHub Pages is enabled with **GitHub Actions** as the deployment source in repository settings.

Expected public URL:

```text
https://uhuhuhuhuhuhuhuh.github.io/Raven/
```

The static edition queries browser-accessible public sources directly. Providers that later require a server proxy should be exposed as local-only rather than silently failing.

## Local mode

### Windows

Double-click or run:

```bat
scripts\run-local.bat
```

Or PowerShell:

```powershell
./scripts/run-local.ps1
```

### Linux/macOS

```bash
./scripts/run-local.sh
```

The scripts create a Python virtual environment, install the FastAPI dependencies, build the frontend if necessary, and start Raven at:

```text
http://127.0.0.1:8742
```

The frontend automatically calls `/api/health`. If Raven's backend answers, the HUD changes to `MODE LOCAL`; otherwise the frontend uses `MODE STATIC`.

## Development

Backend:

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r server/requirements.txt
python -m uvicorn server.main:app --reload --port 8742
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Vite proxies `/api` to `127.0.0.1:8742` while developing.

## API

Current local endpoints:

```text
GET /api/health
GET /api/providers
GET /api/scan?lat=25.7617&lon=-80.1918&radius=1800
GET /api/stats
```

`/api/scan` normalizes public OpenStreetMap camera records into Raven's frontend schema and caches results in `server/data/raven.db`.

## Repository layout

```text
Raven/
├── frontend/               React + TypeScript + Vite + MapLibre
├── server/                 FastAPI local backend
├── scripts/                One-click local launchers
├── .github/workflows/      GitHub Pages deployment
├── RAVEN_WEBUI_PLAN.md     Full product/UX implementation plan
└── README.md
```

## Data-source note

The initial provider uses OpenStreetMap records tagged as surveillance equipment or speed cameras and queries them through the public Overpass API. Metadata is only displayed when present in the source data. Raven retains a link back to the original OpenStreetMap record and contributor attribution.

# Raven

Raven is a map-first public/open-data camera awareness dashboard with one React frontend and two execution modes:

- **Raven Web**: static GitHub Pages application using browser-accessible public sources.
- **Raven Local**: the same compiled WebUI served by Python/FastAPI, with server-side OpenStreetMap/Overpass access, SQLite caching, and cached geocoding.

Raven does not probe private camera systems, bypass authentication, or discover cameras by scanning networks. Camera media is only embedded when the source deliberately publishes it publicly.

## Current architecture

Raven separates five concepts that must not mutate one another implicitly:

1. **Viewport**: what the user is currently looking at.
2. **Last scan**: the exact geographic bounds that were queried.
3. **Reference origin**: the point used for range and azimuth calculations.
4. **Provider data**: fetched camera records retained until the next scan.
5. **Layer visibility**: a derived filter over provider data.

This means turning a layer off hides its contacts without deleting them. Turning it back on restores the already-fetched contacts immediately and does not require another scan.

## Camera media semantics

Raven uses explicit media types:

- `none`: mapped camera location with no public media URL.
- `snapshot`: a public still-image endpoint such as an FL511 JPEG. Raven refreshes it periodically and preloads the next image before swapping frames.
- `stream`: a continuous public video URL when a provider actually exposes one.
- `external`: a public camera page exists but there is no embeddable media URL.

FL511's public ArcGIS camera layer currently exposes an `IMAGE` field, so those cameras are classified as **SNAPSHOT**, not live video. Raven never labels a JPEG as a video stream.

## Scan behavior

`SCAN VIEW` queries the exact visible MapLibre bounding box rather than using an unrelated fixed radius.

- Panning or zooming after a completed scan marks results **STALE**.
- `AUTO SCAN` optionally performs a debounced rescan after viewport movement.
- Starting a new scan aborts the previous one.
- Provider responses are tagged with a unique `scanId`; late results from an obsolete scan are ignored.
- Selecting a contact does not pan the map and therefore cannot silently change the scan area.
- Provider failures are tracked separately. If one provider succeeds and another fails, Raven reports **PARTIAL** rather than falsely reporting READY.

## Current providers

### OpenStreetMap / Overpass

Queries the exact visible bounding box for publicly mapped:

- `man_made=surveillance`
- `highway=speed_camera`

Available worldwide where OpenStreetMap contains those records.

### FL511 / Florida DOT

Queries the public FL511 ArcGIS FeatureServer within Florida coverage. Raven supports ArcGIS pagination beyond the service's 2,000-record page size and records camera description, county, highway, direction, timestamp, coordinates, and public snapshot URL when supplied.

## Map and UI behavior

- Native MapLibre marker clustering at lower zoom levels.
- Separate mapped-camera, snapshot, stream, and speed-camera visibility controls.
- Heatmap and last-scan outline overlays.
- Virtualized Contact Register for large result sets.
- Provider health/error panel.
- Real event timestamps in the system log.
- Desktop tactical layout plus mobile Contacts, Layers, and Log drawers.
- Explicit stale-results banner after viewport changes.
- Visible OpenStreetMap attribution.
- Application-level React error boundary.

## Snapshot viewer

Snapshot cameras default to a 5-second refresh interval. Available refresh settings are:

```text
OFF
1s
3s
5s
10s
30s
```

The viewer preloads the next image before replacing the displayed frame, tracks consecutive image-load failures, and reports ACTIVE, STALE, or OFFLINE state. `sourceUpdatedAt` is displayed separately when the provider supplies it.

## GitHub Pages

The repository deploys from `.github/workflows/pages.yml`.

Public URL:

```text
https://uhuhuhuhuhuhuhuh.github.io/Raven/
```

The deployment job now runs TypeScript checking and unit/state tests before building and publishing the Pages artifact.

## Local mode

### Windows

```bat
scripts\run-local.bat
```

PowerShell:

```powershell
./scripts/run-local.ps1
```

### Linux/macOS

```bash
./scripts/run-local.sh
```

Local Raven is served at:

```text
http://127.0.0.1:8742
```

The frontend probes `/api/health`. If Raven's backend responds, the HUD shows `MODE LOCAL`; otherwise it operates as the static browser edition.

## Local API

```text
GET /api/health
GET /api/providers
GET /api/scan?west=-80.3&south=25.7&east=-80.1&north=25.9
GET /api/search?q=Miami
GET /api/stats
```

The legacy local radius form remains accepted for compatibility:

```text
GET /api/scan?lat=25.7617&lon=-80.1918&radius=1800
```

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

Validation:

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

## Quality gate

Pull requests into `main` run `.github/workflows/quality.yml`, which performs:

- frontend dependency installation
- `tsc --noEmit`
- Vitest state/provider tests
- production Vite build
- Playwright Chromium regression tests in desktop and mobile profiles
- backend dependency installation
- Python syntax validation
- FastAPI `/api/health` smoke test
- Unix launcher shell syntax validation

The regression suite specifically verifies that snapshot visibility toggles are non-destructive and that moving the map after a completed scan marks the current data stale.

## Repository layout

```text
Raven/
├── frontend/
│   ├── src/
│   │   ├── components/       map, media, layers, error handling, virtual list
│   │   ├── providers/        provider adapters and registry
│   │   ├── App.tsx
│   │   ├── search.ts
│   │   ├── state.ts
│   │   └── types.ts
│   ├── e2e/
│   └── playwright.config.ts
├── server/                   FastAPI local backend
├── scripts/                  one-click local launchers
├── .github/workflows/        quality gate + Pages deployment
└── RAVEN_WEBUI_PLAN.md
```

## Source and privacy policy

Raven is intentionally limited to public/openly documented data and public media. It does not include credential bypass, private-IP probing, facial recognition, biometric identification, license-plate OCR, or network camera discovery. Location access is opt-in through the browser's normal geolocation permission flow.

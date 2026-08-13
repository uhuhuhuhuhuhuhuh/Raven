# Raven

Raven is a map-first public/open-data camera awareness dashboard with one React frontend and two execution modes:

- **Raven Web** runs as a static GitHub Pages application and queries browser-accessible public sources.
- **Raven Local** serves the same compiled WebUI from Python/FastAPI and adds server-side OpenStreetMap/Overpass access plus SQLite-backed camera/search caching.

Public site:

```text
https://uhuhuhuhuhuhuhuh.github.io/Raven/
```

Raven does not probe private camera systems, bypass authentication, scan private networks, perform face recognition, identify people, or perform license-plate OCR. Media is used only when a public source deliberately publishes it.

## Architecture

Raven keeps these concepts separate so UI controls cannot corrupt data state:

1. **Viewport**: what the map currently shows.
2. **Last scan**: the exact bounds used by the most recent scan.
3. **Reference origin**: the point used for range and azimuth calculations.
4. **Provider results**: fetched camera records retained independently of layer visibility.
5. **Layers**: derived visibility filters for mapped cameras, snapshots, streams, speed cameras, heat, and scan outline.
6. **Selection**: the focused camera, independent of map/scan state.

Turning a layer off only hides matching records. Turning it back on restores them immediately without rescanning.

## Camera media semantics

Raven distinguishes public camera media explicitly:

- `none`: mapped camera location, no public media endpoint.
- `snapshot`: public still-image endpoint. Raven refreshes it periodically and preloads each new frame before swapping it into view.
- `stream`: the source publishes a live-video capability.
- `external`: an official/public camera page exists but Raven has no embeddable media endpoint.

A camera may have both a snapshot fallback and a live-stream capability. Layer filtering checks actual capabilities rather than destructively forcing a camera into one exclusive bucket.

For a directly published browser-video URL, Raven uses its in-app video player. When an official provider publishes a live-stream viewer page rather than a direct media URL, Raven shows the camera snapshot and an explicit **OPEN OFFICIAL LIVE STREAM** action instead of scraping or guessing an internal stream URL.

## Providers

### OpenStreetMap / Overpass

Publicly mapped worldwide records for:

- `man_made=surveillance`
- `highway=speed_camera`

OSM scanning uses the exact visible viewport. At broader views Raven progressively divides the viewport into bounded tiles and merges/deduplicates each tile as it arrives. OSM scanning is disabled below zoom 8 to avoid sending unreasonable continent/world-scale requests to the public Overpass service.

### FL511 / Florida DOT

Florida public traffic cameras through FL511's public ArcGIS FeatureServer.

Raven supports:

- Florida coverage gating
- ArcGIS pagination past the 2,000-record page size
- public camera snapshots
- description, county, highway, direction, coordinates and source timestamp
- progressive page updates

FL511 ArcGIS `IMAGE` records are **SNAPSHOT** cameras, not falsely labeled live video.

### Caltrans CCTV / California

California public CCTV through Caltrans' official ArcGIS CCTV FeatureServer.

Raven reads the provider's published:

- camera coordinates and location name
- route, county and direction
- service state
- current snapshot URL
- current-image update information
- published streaming-video URL

If the published streaming URL is a direct browser-video resource, Raven can render it directly. If it is Caltrans' official streaming viewer page, Raven opens that viewer explicitly while retaining the public snapshot fallback in Raven.

## Scan behavior

`SCAN VIEW` operates on the exact visible MapLibre bounds.

- New scans abort the previous scan.
- Every scan has a unique `scanId`; obsolete late responses are ignored.
- Providers report progress as tiles/pages complete, so contacts appear incrementally.
- Panning or zooming after a completed scan marks results **STALE**.
- Optional **AUTO SCAN** performs a debounced scan after viewport movement.
- Regional providers are automatically skipped outside their coverage.
- Providers can define a safe minimum zoom. Skipped providers show the reason in Provider Health.
- One provider failing while another succeeds produces **PARTIAL**, not a false READY state.

## Browser provider cache

GitHub Pages mode maintains recent provider scans in IndexedDB, with an in-memory fallback when browser storage is unavailable.

Behavior:

1. A recent exact-bounds cache entry is restored immediately.
2. Raven still refreshes the source from the network.
3. Progressive network results replace the cached result as they arrive.
4. If the network refresh fails, Raven retains the cached data and marks the provider degraded/partial rather than clearing the map.
5. **CLEAR CACHE** removes Raven's browser provider cache.

Provider caching is an availability/performance optimization; failures to read or write browser storage never fail a scan.

## Map and UI

- MapLibre map with native marker clustering
- separate unclustered heatmap source
- exact last-scan outline
- virtualized Contact Register
- mapped/snapshot/stream/speed-camera layer controls
- provider health, progress, coverage and cache state
- real timestamped system log
- camera/provider metadata inspector
- refreshed snapshot viewer with ACTIVE/STALE/OFFLINE state
- direct-video and official-viewer live-stream paths
- desktop tactical layout
- mobile Contacts, Layers/Analytics and Log drawers
- stale-results banner
- React error boundary
- visible OpenStreetMap attribution

## Snapshot viewer

Default refresh is 5 seconds. Available intervals:

```text
OFF
1s
3s
5s
10s
30s
```

The next frame is loaded before replacing the current image. Consecutive image failures transition the viewer through stale/offline states, while provider source timestamps remain visible separately from Raven's local refresh time.

## Local mode

Windows Batch:

```bat
scripts\run-local.bat
```

PowerShell:

```powershell
./scripts/run-local.ps1
```

Linux/macOS:

```bash
./scripts/run-local.sh
```

Local URL:

```text
http://127.0.0.1:8742
```

The launchers use the committed npm lockfile, run `npm ci`, rebuild the frontend on every launch so a pulled update cannot serve stale `dist` files, install Python requirements, then start FastAPI.

## Local API

```text
GET /api/health
GET /api/providers
GET /api/scan?west=-80.3&south=25.7&east=-80.1&north=25.9
GET /api/search?q=Miami
GET /api/stats
```

Legacy compatibility remains available:

```text
GET /api/scan?lat=25.7617&lon=-80.1918&radius=1800
```

`/api/providers` describes OSM/Overpass plus the browser-executed FL511 and Caltrans providers so local and web editions report the same provider inventory.

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
npm ci
npm run dev
```

Full frontend validation:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
```

## Quality gate

Pull requests into `main` run `.github/workflows/quality.yml`:

- deterministic `npm ci` from the committed lockfile
- TypeScript `tsc --noEmit`
- ESLint, including React Rules of Hooks/exhaustive-dependency checks
- Vitest state/provider/cache regressions
- Vite production build
- Playwright desktop Chromium regressions
- Playwright mobile Chromium regressions
- Python syntax check
- FastAPI health/provider smoke test
- launcher shell syntax validation

The GitHub Pages deployment independently repeats deterministic install, typecheck, lint, unit tests and production build before publishing.

## Repository layout

```text
Raven/
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   ├── providers/
│   │   ├── cache.ts
│   │   ├── search.ts
│   │   ├── state.ts
│   │   └── types.ts
│   ├── e2e/
│   ├── eslint.config.js
│   ├── package-lock.json
│   └── playwright.config.ts
├── server/
├── scripts/
├── .github/workflows/
├── RAVEN_AUDIT_COMPLETE.md
├── RAVEN_FINALIZATION_COMPLETE.md
└── RAVEN_WEBUI_PLAN.md
```

## Public-data boundary

Raven is intentionally an open-data/public-media tool. Upstream provider outages, rate limits, missing media, stale cameras, and official viewer-only streams are surfaced as provider/media state rather than bypassed. Raven does not derive private endpoints or use credentials that the source has not deliberately exposed for public access.

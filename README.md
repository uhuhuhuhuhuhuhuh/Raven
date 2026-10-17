# Raven

Raven is a map-first public/open-data camera awareness dashboard with one React frontend and two execution modes:

- **Raven Web** runs as a static GitHub Pages application and queries browser-accessible public sources.
- **Raven Local** serves the same compiled WebUI from Python/FastAPI and adds server-side OpenStreetMap/Overpass access plus SQLite-backed camera/search caching.

Both editions also publish a static [public camera and live-stream API](#public-api) and can read [OpenStreetMap camera tiles built from Geofabrik extracts](#openstreetmap-extract-tiles-geofabrik) instead of querying Overpass.

Public site:

```text
https://uhuhuhuhuhuhuhuh.github.io/Raven/
```

Raven does not probe private camera systems, bypass authentication, scan private networks, perform face recognition, identify people, or perform license-plate OCR. Media is used only when a public source deliberately publishes it.

## Architecture

Raven keeps these concepts separate so UI controls cannot corrupt data state:

1. **Viewport**: what the map currently shows.
2. **Reference origin**: the point used for range and azimuth calculations (the map centre, or your location).
3. **Data sets**: the live-camera catalog and the OpenStreetMap cameras, each with its own status, source and freshness, retained independently of layer visibility.
4. **Layers**: derived visibility filters for mapped cameras, snapshots, streams, speed cameras, plate readers and overlays.
5. **Selection**: the focused camera, independent of map and data state.

Turning a layer off only hides matching records. Turning it back on restores them immediately without any request.

## Camera media semantics

Raven distinguishes public camera media explicitly:

- `none`: mapped camera location, no public media endpoint.
- `snapshot`: public still-image endpoint. Raven refreshes it periodically and preloads each new frame before swapping it into view.
- `stream`: the source publishes a live-video capability: a direct stream Raven plays in-app (HLS `.m3u8` or progressive video), or an official viewer page.
- `external`: an official/public camera page exists but Raven has no embeddable media endpoint.

A camera may have both a snapshot fallback and a live-stream capability. Layer filtering checks actual capabilities rather than destructively forcing a camera into one exclusive bucket.

For a directly published stream URL, Raven plays it in-app. HLS playlists use the browser's native player where one exists (Safari, iOS, Android); elsewhere Raven loads [hls.js](https://github.com/video-dev/hls.js) on demand, as a separate chunk only when a stream is opened. The viewer reports CONNECTING / LIVE / STREAM UNAVAILABLE. If a stream cannot play, it falls back to the refreshing snapshot and offers a retry.

When an official provider publishes a live-stream viewer page rather than a direct media URL, Raven shows the camera snapshot and an explicit **OPEN OFFICIAL LIVE STREAM** action instead of scraping or guessing an internal stream URL. Only URLs an agency publishes in its own open data are played.

## Providers

### OpenStreetMap / Overpass

Publicly mapped worldwide records for:

- `man_made=surveillance`
- `highway=speed_camera`

On the published site these come from [vector tiles](#openstreetmap-extract-tiles-geofabrik) built weekly from the Geofabrik US extract: the map renders them directly at every zoom, and only the few-kilobyte tiles in view are ever downloaded. Clicking a camera fetches its full OSM record from the matching JSON tile.

Without published tiles (Raven Local without an extract, or a deploy where the extract build failed) the browser asks the public Overpass service for the area around the view, padded by a third so small pans need no new request, and never below zoom 8.

- Overpass requests retry at most twice on 429/502/503/504, honouring `Retry-After`.
- If some requests fail, what loaded stays on the map and the data set is marked **partial**.
- Viewing directions come from `camera:direction` (falling back to `direction`), in degrees or compass points such as `SW`.

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

Caltrans publishes a direct HLS playlist (`wzmedia.dot.ca.gov/.../playlist.m3u8`) for roughly two thirds of its cameras, and Raven plays those live in-app. The stream host sends `Access-Control-Allow-Origin: *`, so playback works from GitHub Pages without a proxy. If a record instead publishes an official viewer page, Raven opens that viewer explicitly while retaining the public snapshot fallback in Raven.

## How data loads

Raven has no scan button. Data arrives in two ways, always for the area in view:

**Published data (GitHub Pages, and Raven Local after a `build:api`).** The deploy writes
`api/v1/cameras.json` (every live traffic camera, about 400 KB compressed) and
`api/v1/osm/cameras.pmtiles` (every OpenStreetMap camera as vector tiles). The browser loads
the catalog once and filters it by viewport locally; the map requests only the vector tiles
it is drawing. Panning and zooming cost no agency or Overpass requests at all.

**On-demand providers (fallback).** When a published file is missing, the relevant providers
are asked for the view padded by a third, and asked again only once the view leaves that
area. Regional providers are skipped outside their coverage or below their minimum zoom,
and one provider failing while another succeeds marks the data set **partial**, not ready.

The status pill shows the result: *Loading cameras…*, *Up to date*, *Some data unavailable*
or *Data unavailable*. The **Sources** tab lists each data set with its source and the date
of its data.

## Map and UI

The interface is a full-bleed map with floating glass panels:
- a top bar with search, telemetry (origin, cameras in view, data date) and data status;
- a Cameras-in-view panel;
- a tabbed side panel (Overview, Layers, Sources);
- an icon dock of actions (my location, share link, export, add camera);
- a map legend whose items toggle their layer.

Text uses self-hosted Inter and JetBrains Mono, so there are no third-party font requests. On phones and tablets (1100 px and below), panels become bottom sheets behind a tab bar.

Camera markers encode their class twice, by hue and by shape: blue dot/ringed dot for snapshot/live stream, an orange diamond for plate readers, aqua circle/square for mapped/speed cameras. A map can put any two markers side by side, and only three hues pass colour-vision checks across every pair (validated with the dataviz palette validator), so shape carries the rest.

- MapLibre map on an [OpenFreeMap](https://openfreemap.org/) dark vector basemap, tinted to Raven's palette. OpenFreeMap is free, keyless and cookie-free, and built for app traffic, unlike the volunteer-run `tile.openstreetmap.org`. If it cannot be reached, the map falls back to OSM raster tiles.
- OpenStreetMap cameras from pre-clustered vector tiles (one cluster colour per class), live cameras clustered by MapLibre
- heatmap overlay over both data sets
- virtualized camera list; zoomed out over the tiles it shows an estimated count and asks you to zoom in
- mapped/snapshot/stream/speed-camera layer controls, with a colour key
- **Plate readers (ALPR)**: OSM `surveillance:type=ALPR` cameras get their own violet layer and counts, with the `manufacturer` shown when mapped
- **Newly mapped**: rings around cameras added to OSM since the previous weekly extract, plus added/removed counts and an Atom feed link in the analytics rail. These show mapping activity, not installation dates.
- **Field of view** wedges (from z15) for cameras whose source publishes a viewing direction. These are illustrative (60°, 45 m), and nothing is drawn for cameras without a direction.
- **Range rings** (250 m – 5 km) around the reference origin
- shareable view links: the address bar tracks `#map=zoom/lat/lon`, and opening one restores that view
- Contact Register filter by name, route, operator, zone or class
- **Export** downloads the listed cameras as GeoJSON, with every source's attribution
- **Share** copies a link to the current view
- **Edit on OpenStreetMap** on OSM records, and **Add camera**, which opens the OSM editor at the map centre
- layer choices remembered in `localStorage`
- data-set status, source and freshness in the Sources tab
- camera/provider metadata inspector
- refreshed snapshot viewer with ACTIVE/STALE/OFFLINE state
- direct-video and official-viewer live-stream paths
- desktop tactical layout
- mobile Cameras, Overview, Layers and Sources drawers
- React error boundary
- visible OpenStreetMap attribution
- accessibility: labelled controls, a polite live region for data status, Escape to close the detail card or drawer, visible focus rings, and `prefers-reduced-motion` support

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

The launchers use the committed npm lockfile, run `npm ci`, rebuild the frontend on every launch so a pulled update cannot serve stale `dist` files, build the [public API](#public-api) files, install Python requirements, then start FastAPI.

## Local API

```text
GET /api/health
GET /api/providers
GET /api/scan?west=-80.3&south=25.7&east=-80.1&north=25.9
GET /api/search?q=Miami
GET /api/stats
```

The same static API as GitHub Pages is served under `/api/v1/` (`index.json`, `cameras.json`, `streams.json`, and `osm/` when extract tiles are present).

`/api/scan` refuses boxes larger than about 500,000 km² (`RAVEN_MAX_BBOX_KM2`) so the public Overpass service never receives world-scale queries, and `/api/search` sends at most one request per second to Nominatim, per its usage policy (`RAVEN_NOMINATIM_MIN_INTERVAL`). Cached rows older than the longest TTL are pruned.

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

Backend tests:

```bash
pip install -r server/requirements-dev.txt
python -m pytest
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
- pytest suite: API validation, normalisation, caching, retry/throttle, cache pruning and connection handling, plus the extract tile builder
- shell script syntax validation

The GitHub Pages deployment independently repeats deterministic install, typecheck, lint, unit tests and production build before publishing. It then adds the extract tiles and the public API, and redeploys daily to keep the catalog current.

## Repository layout

```text
Raven/
├── frontend/
│   ├── src/
│   │   ├── components/      # map, register, snapshot + live HLS viewers
│   │   ├── providers/       # OSM (Overpass + extract tiles), FL511, Caltrans, ArcGIS paging
│   │   ├── cache.ts
│   │   ├── geo.ts           # distance, bearing, viewport normalisation
│   │   ├── overlays.ts      # field-of-view wedges, range rings
│   │   ├── staticApi.ts     # public API documents
│   │   ├── search.ts
│   │   ├── state.ts
│   │   └── types.ts
│   ├── scripts/build-api.ts
│   ├── e2e/
│   ├── eslint.config.js
│   ├── package-lock.json
│   └── playwright.config.ts
├── server/                  # FastAPI app + pytest suite
├── scripts/                 # launchers, Geofabrik fetch + tile builder
├── .github/workflows/
├── RAVEN_AUDIT_COMPLETE.md
├── RAVEN_FINALIZATION_COMPLETE.md
└── RAVEN_WEBUI_PLAN.md
```

## Public API

GitHub Pages cannot run a server, so Raven publishes its API as static JSON generated on every deploy (and daily). Pages sends `Access-Control-Allow-Origin: *`, so any site or tool can call it:

```text
https://uhuhuhuhuhuhuhuh.github.io/Raven/api/v1/index.json     manifest + per-provider health
https://uhuhuhuhuhuhuhuh.github.io/Raven/api/v1/cameras.json   every FL511 and Caltrans camera
https://uhuhuhuhuhuhuhuh.github.io/Raven/api/v1/streams.json   cameras with a playable published live stream
https://uhuhuhuhuhuhuhuh.github.io/Raven/api/v1/cameras.geojson  the same catalogs as GeoJSON, for QGIS, uMap and similar tools
https://uhuhuhuhuhuhuhuh.github.io/Raven/api/v1/streams.geojson
https://uhuhuhuhuhuhuhuh.github.io/Raven/api/v1/osm/index.json   OpenStreetMap extract tile index (when built)
https://uhuhuhuhuhuhuhuh.github.io/Raven/api/v1/osm/changes.json cameras added to / removed from OSM since last week
https://uhuhuhuhuhuhuhuh.github.io/Raven/api/v1/osm/changes.atom Atom feed of newly mapped cameras
```

A `streams.json` record:

```json
{
  "id": "caltrans-1022",
  "provider": "caltrans-cctv",
  "name": "TVA22 -- I-680 : AT SHERIDAN RD",
  "lat": 37.56166,
  "lon": -121.90489,
  "direction": "North",
  "zone": "Alameda",
  "snapshotUrl": "https://cwwp2.dot.ca.gov/data/d4/cctv/image/tva22i680atsheridanrd/tva22i680atsheridanrd.jpg",
  "stream": { "url": "https://wzmedia.dot.ca.gov/D4/N680_at_Sheridan_Rd.stream/playlist.m3u8", "format": "hls", "online": true },
  "attribution": "Caltrans / State of California"
}
```

`scripts/build-api.ts` generates the files by running the same TypeScript providers the map uses over each provider's full coverage area, so the API and the app always agree. A provider that is down is recorded in `index.json` instead of failing the deploy. Build locally with `npm run build:api` (writes `dist/api/v1`).

**Stream health.** About a third of the stream URLs Caltrans publishes do not answer at any given time. With `--check-streams`, which every Pages deploy uses, the build requests each playlist once:
- `stream.online` records whether it returned a real HLS playlist (`streams.json` carries `healthCheckedAt`, and `index.json` a per-provider `streamsOnline`);
- the check runs 24 at a time with a 5 s timeout and a 5 minute overall budget, and any stream not reached in time is left unmarked rather than reported offline.

## OpenStreetMap extract tiles (Geofabrik)

[Geofabrik](https://download.geofabrik.de/north-america/us.html) publishes daily OpenStreetMap extracts with `.poly` boundaries. The Pages workflow turns the US extract into static camera tiles, at most once a week:

1. `scripts/fetch-geofabrik-cameras.sh north-america/us <dir>` streams the ~11 GB extract through `osmium tags-filter`, so only surveillance and speed-camera nodes reach the disk. A truncated download fails the step.
2. `scripts/build_osm_tiles.py` writes 0.5° JSON tiles plus `osm/index.json`, which records the coverage boundary, the extract's data date and the ODbL notice. With [tippecanoe](https://github.com/felt/tippecanoe) installed it also writes `osm/cameras.pmtiles`: one [PMTiles](https://docs.protomaps.com/pmtiles/) archive (about 24 MB for the US) with a vector-tile layer per marker class, points clustered below zoom 14. GitHub Pages serves it with HTTP range requests, so the map reads a few kilobytes per tile.
3. With `--previous` pointing at last week's tiles (restored from the Actions cache), it also writes `osm/changes.json` with the cameras added and removed since then. With `--site-url` it writes `osm/changes.atom`, one entry per newly mapped camera, linking to its spot on the map.
4. If Geofabrik is unavailable, the deploy ships last week's tiles, or none, and the map uses Overpass.

The first production build, on 2026-09-24, published 184,587 US camera nodes in 2,301 tiles.

The map draws the vector tiles directly. When a camera is selected, its full record is read from the JSON tile for that spot. Records carry attribution such as `© OpenStreetMap contributors · Geofabrik north-america/us, data as of 2026-10-14`.

For Raven Local, build tiles for any extract (a state is far smaller than the whole US) into `frontend/public`, which each launch copies into the site:

```bash
pip install -r scripts/requirements-osm.txt
python scripts/build_osm_tiles.py --pbf florida-latest.osm.pbf --poly florida.poly \
  --source "Geofabrik north-america/us/florida" --out frontend/public/api/v1/osm
```

`frontend/public/api/` is gitignored, so local extracts are never committed.

## Public-data boundary

Raven is intentionally an open-data/public-media tool. Upstream provider outages, rate limits, missing media, stale cameras, and official viewer-only streams are surfaced as provider/media state rather than bypassed. Raven does not derive private endpoints or use credentials that the source has not deliberately exposed for public access.

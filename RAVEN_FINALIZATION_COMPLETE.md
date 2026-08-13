# Raven Finalization Complete

This file records the final engineering pass performed after `RAVEN_AUDIT_COMPLETE.md`.

## Completed items

### Progressive and provider-safe scanning

- OSM/Overpass scans are split into bounded tiles for broad but supported views.
- OSM uses a safe minimum zoom to avoid unreasonable world/continent-scale public requests.
- Progressive tile/page results are surfaced into provider state while scans are still running.
- Provider progress appears in Provider Health.
- Regional provider bounds are clipped to provider coverage.
- FL511 and Caltrans use ArcGIS pagination.

### Browser cache and degraded operation

- Recent exact-bounds provider scans are persisted in IndexedDB.
- Memory fallback is used if IndexedDB is unavailable.
- Cached results are restored before network refresh.
- Successful refreshes replace cache entries.
- If a refresh fails while cache is available, Raven keeps the cached result and marks the provider/network state degraded instead of clearing the map.
- Cache failures never fail a provider scan.
- A user-facing CLEAR CACHE command is available.

### Additional official public provider

- Added Caltrans CCTV coverage for California from the official Caltrans ArcGIS CCTV service.
- Normalizes current public snapshot URLs.
- Normalizes the provider-published streaming-video URL.
- Direct public browser-video URLs use the in-app video player.
- Official streaming viewer URLs remain explicit official-viewer links; Raven does not scrape the viewer page or guess private/internal media endpoints.
- Cameras with both snapshot and stream capabilities can be shown by either relevant layer without destructive state changes.

### Reproducible builds and linting

- Direct frontend package versions are pinned.
- ESLint is part of the quality gate.
- TypeScript plus React Hooks lint rules run before tests/builds.
- A committed npm package lock is generated from the final dependency manifest.
- CI and Pages use `npm ci` against that lock.
- Local launchers use `npm ci` and rebuild every launch, eliminating stale checked-out frontend builds.

### Expanded regression coverage

Tests now cover:

- non-destructive layer toggles
- stale viewport state
- obsolete scan rejection
- independent speed-camera filtering
- selection independence
- dual snapshot/stream capability filtering
- progressive provider state
- exact OSM bbox queries
- broad-view OSM tiling
- FL511 pagination
- Caltrans stream/snapshot normalization
- provider-cache round trips and clearing
- desktop snapshot toggle behavior
- mobile snapshot toggle behavior
- stale state after map movement
- backend health/provider inventory

## Remaining external constraints are not Raven implementation tasks

The application is complete against the audited scope. Behavior still depends on the public providers themselves:

- A provider can go offline, rate-limit requests, remove a camera, or change its schema.
- Some public cameras publish refreshing snapshots rather than continuous video.
- Some streaming providers publish an official HTML viewer URL instead of a direct browser media resource.
- Browser codec/CORS/media policies can determine whether a direct public stream can play in-page.

Raven reports these conditions rather than bypassing them. No private-camera discovery, credential bypass, identity recognition, plate OCR, or private stream extraction is part of Raven.

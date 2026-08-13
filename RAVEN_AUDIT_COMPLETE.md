# Raven 1.0 Hardening Audit

This document records the correctness and stability audit completed for the Raven WebUI after the initial public-camera prototype.

## Resolved state/data-flow defects

- Provider results and layer visibility are separate state.
- Hiding snapshots/streams never deletes fetched provider data.
- Re-enabling a layer restores already-fetched records without requiring a scan.
- Every scan has a unique `scanId`.
- Starting a scan aborts the previous scan.
- Late provider responses are rejected unless they belong to the active `scanId`.
- Viewport, last scan, reference origin, and selection are separate concepts.
- Selecting a contact does not pan the map or mutate scan/reference state.
- Panning or zooming after a completed scan marks results `dirty` and presents an explicit stale-results banner.
- Auto Scan performs a debounced rescan only after viewport movement.
- Provider failures are preserved individually and overall scan status becomes `partial` when only part of the provider set succeeds.
- System-log entries retain their actual event timestamps.

## Resolved camera-media defects

- `live-feed` is no longer used as a catch-all camera type.
- Camera media is explicitly `none`, `snapshot`, `stream`, or `external`.
- FL511 ArcGIS `IMAGE` values are classified as snapshots.
- Snapshot URLs are no longer duplicated into a fake video/stream field.
- Snapshot frames are periodically refreshed with cache-busting.
- New frames are preloaded before display to avoid blank flashes.
- Snapshot viewer tracks load failures and exposes active/stale/offline state.
- Source update timestamps are displayed separately from browser refresh time.
- Continuous public video has a separate `<video>` rendering path when a provider genuinely supplies `streamUrl`.

## Resolved scan/map defects

- Scan geometry is the exact visible MapLibre viewport bounds.
- The previous 20 km local API radius ceiling no longer conflicts with frontend scanning.
- A last-scan outline can be toggled independently.
- Contact points use native MapLibre clustering.
- Heatmap rendering uses a separate unclustered source.
- Contact Register rows are virtualized.
- Speed cameras have an independent layer from general mapped cameras.
- FL511 provider is coverage-gated to Florida.
- FL511 ArcGIS pagination continues when the service reports an exceeded transfer limit.
- FL511 text directions are preserved as labels instead of being discarded when they are not numeric bearings.
- Public source URLs are separate from snapshot media URLs.

## Resolved UX/accessibility defects

- Camera-layer controls expose `aria-pressed` state.
- Desktop and mobile both expose Contacts, Layers/Analytics, Log, and Scan controls.
- Mobile no longer drops the data panels entirely; they are drawers.
- Selected camera detail closes automatically if its layer is hidden.
- React render failures are contained by an application error boundary.
- OpenStreetMap attribution is visible on the map and in the Raven command footer.
- Startup no longer injects demo cameras into the real data state.

## Resolved provider/search defects

- Provider adapters are isolated under `frontend/src/providers/`.
- Provider coverage and capabilities are declared in the registry.
- OpenStreetMap scans use exact bounding boxes.
- Static search caches Nominatim results and enforces a one-request-per-second interval.
- Coordinate search is resolved locally without Nominatim.
- Local search runs through FastAPI with SQLite caching and an identifying Raven user agent.
- Local `/api/scan` accepts exact viewport bounds and keeps legacy lat/lon/radius parameters for compatibility.

## Quality gate

Pull requests to `main` must pass:

- TypeScript `tsc --noEmit`
- Vitest state/provider regression tests
- Vite production build
- Playwright Chromium desktop regression tests
- Playwright Chromium mobile regression tests
- Python syntax validation
- FastAPI health endpoint smoke test
- Unix launcher syntax validation

GitHub Pages deployment independently reruns TypeScript checks and unit tests before publishing.

## External-source constraints

These are source capabilities, not unresolved Raven bugs:

- The public FL511 ArcGIS layer currently provides an `IMAGE` field for camera imagery rather than a per-record continuous-video URL. Raven therefore presents those records as refreshing snapshots.
- Raven will render a continuous stream when an official/public provider supplies a genuine `streamUrl`; it does not derive, guess, scrape private endpoints, or bypass authentication to manufacture one.
- Public services can rate-limit, temporarily fail, or change their published schemas. Raven exposes provider health and partial scan states rather than hiding those failures.

## Privacy and access boundary

Raven is intentionally limited to public/openly documented camera metadata and deliberately public media. It does not probe private networks, bypass credentials, access private camera systems, identify people, or perform biometric/plate recognition.

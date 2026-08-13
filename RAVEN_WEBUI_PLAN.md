# Raven WebUI Dashboard Implementation Plan

## 1. Project Goal

Build **Raven**, a browser-based open-data surveillance-awareness dashboard inspired by the interface and feature set shown on the SGP Flock Camera product page, but implemented as an original Raven application with its own branding, code, assets, data model, and visual identity.

The target experience is a dense, map-first tactical dashboard: a full-screen interactive map in the center, a live contact/camera register on the left, status and classification panels on the right, a compact HUD across the top, and system controls/logging along the bottom.

Raven should operate only on public/open data and user-provided data. It must not require access to private camera systems or credentials. AI features should be limited to anonymous object detection/classification such as vehicle, bicycle, and pedestrian classes, not facial recognition or identity matching.

## 2. Reference Experience to Recreate

The reference UI uses a full-screen tactical display with the following major regions:

- Top HUD with product identity, current map origin coordinates, UTC/grid time, scan radius, contact count, search field, and system status.
- Left-side **Contact Register** containing nearby camera/site entries with type, range, azimuth/bearing, and compact classification tags.
- Large central map containing camera markers, site markers, user position, scan radius, field-of-view/range overlays, and density visualization.
- Right-side summary stack showing detected count, classification breakdown, nearest contact, and installation/site categories.
- Bottom-left system/event log.
- Bottom-center command bar for scan area, GPS/location, live-feed mode, alternate vision/display modes, scan radius, and layer toggles.
- Map popovers/cards showing the selected camera/site metadata.
- Very dark map styling with green linework, cyan active elements, amber/yellow camera/contact indicators, red/orange alert states, thin HUD borders, scanline/noise effects, and condensed technical typography.

Raven should preserve this information architecture because it works well for a map-heavy dashboard, while replacing SGP naming, logos, icons, imagery, and copy.

## 3. Raven Visual Identity

### Core style

Use a dark command-console aesthetic rather than a normal SaaS dashboard.

Recommended design tokens:

- Background: near-black / green-black.
- Panel surface: translucent dark green-gray.
- Primary active: phosphor green.
- Secondary active: cyan/aqua.
- Camera/contact: amber.
- Warning: orange.
- Critical: red.
- Muted text: gray-green.
- Borders: 1px low-opacity green/cyan.

### Typography

Use an open-source condensed or monospaced font for the HUD and numeric readouts. A two-font system works best:

- Display/HUD: condensed technical face.
- Data/body: monospaced face.

Letter spacing should be relatively wide for labels such as `CONTACT REGISTER`, `GRID TIME`, `SYSTEM`, and `DETECTED`.

### Effects

Keep effects subtle enough not to hurt map readability:

- low-opacity scanlines
- faint CRT/noise texture
- soft glow on active icons
- animated pulse around current location
- sweep/radar animation only during an explicit scan action
- restrained hover glow on controls

Include a setting to disable all cosmetic effects for accessibility/performance.

## 4. Primary Desktop Layout

Use CSS Grid for the main shell.

Suggested arrangement:

```text
+--------------------------------------------------------------------------+
| RAVEN | ORIGIN | GRID TIME | RADIUS | CONTACTS | SEARCH | SYSTEM STATUS |
+----------+--------------------------------------------------+------------+
|          |                                                  |            |
| CONTACT  |                                                  | DETECTED   |
| REGISTER |                    MAP                           | CLASSIFY   |
|          |                                                  | NEAREST    |
|          |                                                  | SITES      |
|          |                                                  |            |
+----------+--------------------------------------------------+------------+
| SYSTEM   |  SCAN | GPS | LIVE | VISION | RADIUS | LAYERS  | LOAD DATA |
| LOG      |                                                  |            |
+----------+--------------------------------------------------+------------+
```

Desktop target: 1440p and 1080p first. The UI should also degrade cleanly to tablets and mobile.

### Responsive behavior

For widths below roughly 1000px:

- map remains primary and full-screen
- left register becomes a slide-out drawer
- right analytics becomes a slide-out drawer
- bottom controls collapse into a horizontally scrollable command tray
- top HUD condenses to Raven logo, search, current count, and menu
- selecting a marker opens a bottom sheet instead of a floating desktop panel

## 5. Main Screens and Modes

### 5.1 Live Map

Default screen.

Capabilities:

- pan/zoom map
- search city/address/place
- geolocate user with permission
- load cameras and public sites inside current viewport or scan radius
- cluster markers at low zoom
- expand clusters progressively
- click/tap a marker to inspect details
- enable/disable camera, civic, live-feed, and user-imported layers
- optional user-centered range rings
- optional field-of-view wedges when orientation data exists
- heatmap/density mode

### 5.2 Camera Explorer

A searchable/tabular view of loaded camera records.

Columns/fields:

- record ID
- type
- source
- latitude/longitude
- street/address if available
- bearing/direction if available
- live-feed availability
- distance from current origin
- source timestamp / last refresh

Selecting a row should focus the same record on the map.

### 5.3 Public Live Feeds

A grid/list of officially published public traffic or city feeds supplied by supported public data sources.

Features:

- source jurisdiction
- camera name/location
- preview
- open full viewer
- refresh/reconnect status
- optional object-detection overlay

Do not scrape authenticated/private feeds.

### 5.4 Analytics

Aggregate visualization of currently loaded public data:

- cameras in viewport/radius
- counts by camera type
- counts by source
- camera density by grid cell
- nearest mapped contacts
- live-feed availability
- public-site categories
- data freshness distribution

Avoid presenting a fabricated "threat" score. If the visual design needs a prominent summary gauge, use a neutral metric such as **coverage density**, **data density**, or **scan completeness**.

### 5.5 History / Session Log

Track actions performed during the current Raven session:

- searches
- scans
- layer changes
- selected contacts
- imported datasets
- live feeds opened

Make persistent history opt-in. The default should be local/session-only storage.

### 5.6 Data Sources / Database

A management view for public datasets.

Show:

- source name
- source type
- enabled/disabled
- record count
- last successful refresh
- license/source attribution
- health/error status

Allow users to import local GeoJSON/JSON/CSV camera datasets.

### 5.7 Settings

Settings groups:

- appearance
- map provider/style
- units (metric/imperial)
- default radius
- geolocation behavior
- automatic refresh interval
- animation/effect intensity
- performance controls
- local cache limits
- object detection settings
- data-source enable/disable
- privacy/history controls

## 6. Map Layer Model

Raven should use independent togglable layers.

Initial layer set:

1. **CAMERAS**
   - fixed CCTV
   - dome/PTZ
   - traffic camera
   - publicly mapped ALPR/LPR where the data source legally/openly publishes it
   - other/unknown

2. **LIVE**
   - public traffic feeds
   - public city webcams

3. **SITES**
   - police
   - fire
   - hospitals/EMS
   - government/public institutions
   - optional user-defined POI categories

4. **RINGS**
   - scan radius rings

5. **FOV**
   - camera facing direction/field-of-view approximations when source data provides orientation

6. **HEAT**
   - density heatmap

7. **USER DATA**
   - imported GeoJSON/CSV layers

Every marker and derived overlay must retain its source attribution.

## 7. Contact Register Behavior

The left panel should dynamically represent visible or nearby map contacts.

Each row:

```text
023  FIXED CAM        [CAM]
     RNG 814 m  AZ 231°
```

Sort modes:

- nearest
- newest/updated
- type
- source
- bearing

Filters:

- camera type
- live only
- source
- distance
- has bearing

Hovering a row highlights its marker. Clicking a row centers the map and opens its detail card.

For very large result sets, use list virtualization.

## 8. Selected Contact Detail Card

When a user selects a camera/site, show:

- Raven record ID
- source record ID
- classification/type
- coordinates
- human-readable address when available
- bearing/orientation
- distance and bearing from current origin
- public feed status/URL availability
- source name
- source license/attribution
- source last-updated timestamp
- record last-fetched timestamp

Actions:

- center map
- copy coordinates
- open original public source
- open public feed when applicable
- add temporary bookmark
- hide record for current session

Do not invent camera resolution, operational state, owner, or other metadata not present in the source.

## 9. Search and Scan Workflow

### Search

The top search box should accept:

- city
- address
- place name
- latitude,longitude

Selecting a result recenters the map and updates the `ORIGIN` readout.

### Scan Area

`SCAN AREA` is a UI operation, not an RF/network scan.

When activated:

1. determine current map/origin and selected radius
2. query enabled public datasets for records inside the bounding region
3. normalize records
4. update map/register/analytics
5. write a human-readable event to the session log
6. animate the scan sweep while data is loading

This avoids misleading users into believing Raven is electronically discovering nearby cameras.

## 10. Public Data Ingestion Architecture

Create a provider adapter interface so sources can be added without changing the UI.

Example interface:

```ts
interface RavenProvider {
  id: string;
  name: string;
  attribution: string;
  capabilities: ProviderCapability[];
  search(bounds: Bounds, options?: SearchOptions): Promise<RavenFeature[]>;
  getById?(id: string): Promise<RavenFeature | null>;
}
```

Normalize provider output to one internal schema.

Potential source categories:

- OpenStreetMap/open community mapping data
- public transportation department traffic-camera feeds/APIs
- municipal open-data portals
- publicly distributed GeoJSON/CSV datasets
- user-imported local datasets

Do not make the frontend depend on one third-party API format.

## 11. Internal Data Model

Core normalized record:

```ts
type RavenFeature = {
  id: string;
  providerId: string;
  sourceId?: string;
  kind: 'camera' | 'site' | 'live-feed';
  cameraType?: 'fixed' | 'dome' | 'ptz' | 'traffic' | 'alpr' | 'unknown';
  name?: string;
  lat: number;
  lon: number;
  address?: string;
  bearing?: number;
  feedUrl?: string;
  sourceUrl?: string;
  attribution?: string;
  sourceUpdatedAt?: string;
  fetchedAt: string;
  metadata: Record<string, unknown>;
};
```

Keep raw provider payload only when necessary for debugging and never let raw field names leak throughout UI code.

## 12. Recommended Technical Stack

Because the repository is currently empty, start with a clean modern web stack.

### Frontend

- React
- TypeScript
- Vite
- MapLibre GL JS for the map
- Zustand for local UI/session state
- TanStack Query for asynchronous provider requests/cache
- CSS Modules or a small tokenized CSS layer
- Lucide or custom original Raven SVG icons

### Optional backend/proxy

Use a small Node/TypeScript service only where needed for:

- CORS-safe access to public data sources
- source normalization
- rate-limit handling
- server-side caching
- scheduled refresh/indexing

A pure static/GitHub Pages build can still support providers that expose browser-safe CORS endpoints, local file import, MapLibre rendering, and on-device AI.

### Storage

Start browser-first:

- IndexedDB for cached normalized features
- localStorage for lightweight settings
- sessionStorage/in-memory store for temporary session history

Add a server database later only if Raven needs shared indexes or multi-user accounts.

## 13. On-Device Object Detection

Object detection should be optional and only run on a public feed the user explicitly opens.

Design:

- load a browser-compatible object-detection model lazily
- process reduced-resolution frames to control CPU/GPU load
- draw boxes locally in canvas/WebGL
- return anonymous classes such as person, car, truck, bus, motorcycle, bicycle
- do not upload frames by default
- do not implement facial recognition, person re-identification, license-plate OCR, or biometric identification

UI should clearly distinguish **map metadata** from **model detections**.

## 14. Vision / Display Modes

Recreate the reference UI's display controls as visual map/feed modes rather than implying access to special sensors.

Modes:

- `NORMAL`: default map/feed colors
- `NIGHT-VIS`: green monochrome visual filter
- `THERMAL`: false-color display filter
- `HIGH-CONTRAST`: accessibility-oriented contrast mode

These are presentation modes only unless a public source explicitly supplies actual thermal/IR imagery.

## 15. Bottom Command Bar

Desktop command set:

- `SCAN AREA`
- `GPS`
- `LIVE`
- `VISION`
- radius slider/input
- `RINGS`
- `FOV`
- `SITES`
- `WEBCAM`
- `HEAT`
- `LOAD DATA`

Behavior should be keyboard accessible and expose tooltips on hover/focus.

Suggested keyboard shortcuts:

- `/` focus search
- `S` scan current area
- `G` toggle GPS mode
- `L` toggle live-feed markers
- `H` toggle heatmap
- `R` toggle range rings
- `F` toggle FOV
- `Esc` close active detail/drawer

## 16. Top HUD

Suggested Raven top bar:

```text
RAVEN v0.1
OPEN-DATA AWARENESS GRID

ORIGIN      25.7617, -80.1918
GRID TIME   07:35:22 UTC
SCAN RADIUS 1.80 KM
CONTACTS    124
[ search city / address / place... ]
SYSTEM      ● READY
```

System states:

- READY
- SCANNING
- PARTIAL DATA
- OFFLINE
- SOURCE ERROR

Avoid the word `LOCKED` unless it has a defined non-security meaning.

## 17. Right Analytics Rail

Recommended panels:

### DETECTED / LOADED
Large number of currently loaded records.

### CLASSIFICATION
Compact horizontal distribution bars by camera class.

### NEAREST
Distance and type of nearest loaded contact from the current origin.

### INSTALLATIONS
Count public-service site types.

### DATA HEALTH
Provider success/failure and freshness indicator.

Do not label public camera presence as a threat level.

## 18. System Log

Use a human-readable pseudo-console.

Example:

```text
03:02:01  SCAN     QUERYING PUBLIC SOURCES
03:02:02  OSM      124 CAMERA RECORDS
03:02:03  CITY-DOT 31 PUBLIC LIVE FEEDS
03:02:03  MAP      155 CONTACTS LOADED
03:02:05  GPS      LOCATION MODE ENABLED
```

Logs must represent real application actions and provider results, not fake activity.

## 19. Performance Requirements

Target smooth interaction with large urban result sets.

Requirements:

- marker clustering at low zoom
- viewport-based querying
- request debouncing while map is moving
- abort stale requests
- worker-based parsing for large GeoJSON/CSV files
- virtualize large side lists
- memoize derived distance/bearing calculations
- avoid rendering thousands of DOM markers; use MapLibre symbol/circle layers
- lazy-load live feeds and AI models
- configurable maximum cached records

Initial benchmark target:

- 10,000 mapped records without major UI stalls on a normal desktop
- 60 FPS map panning where practical
- first usable shell in under ~2 seconds on a warm load

## 20. Privacy and Responsible-Use Rules

Raven should make the distinction between public awareness and private surveillance explicit.

Rules:

- only public/openly licensed or user-supplied datasets
- no authentication bypass
- no credential harvesting
- no probing private camera IP ranges
- no automatic network scanning for cameras
- no facial recognition
- no identity matching
- no license-plate OCR built into the AI layer
- source attribution retained per record
- GPS stays opt-in and browser-permission controlled
- session history local by default

## 21. Repository Structure

Recommended starting layout:

```text
Raven/
├─ README.md
├─ RAVEN_WEBUI_PLAN.md
├─ LICENSE
├─ package.json
├─ vite.config.ts
├─ tsconfig.json
├─ public/
│  ├─ icons/
│  └─ textures/
├─ src/
│  ├─ app/
│  │  ├─ App.tsx
│  │  ├─ router.tsx
│  │  └─ providers.tsx
│  ├─ components/
│  │  ├─ hud/
│  │  ├─ map/
│  │  ├─ contacts/
│  │  ├─ analytics/
│  │  ├─ command-bar/
│  │  ├─ system-log/
│  │  └─ common/
│  ├─ features/
│  │  ├─ scan/
│  │  ├─ search/
│  │  ├─ live-feeds/
│  │  ├─ vision/
│  │  ├─ import/
│  │  └─ settings/
│  ├─ map/
│  │  ├─ layers/
│  │  ├─ styles/
│  │  └─ controls/
│  ├─ providers/
│  │  ├─ types.ts
│  │  ├─ registry.ts
│  │  └─ adapters/
│  ├─ store/
│  ├─ workers/
│  ├─ utils/
│  ├─ styles/
│  └─ types/
└─ tests/
```

## 22. Component Breakdown

Core React components:

- `RavenShell`
- `TopHud`
- `OriginReadout`
- `GridClock`
- `GlobalSearch`
- `SystemStatus`
- `ContactRegister`
- `ContactRow`
- `RavenMap`
- `MapLayers`
- `SelectedFeatureCard`
- `AnalyticsRail`
- `ClassificationBars`
- `NearestContact`
- `InstallationSummary`
- `DataHealth`
- `SystemLog`
- `CommandBar`
- `ScanButton`
- `GpsToggle`
- `VisionModeControl`
- `LayerToggles`
- `RadiusControl`
- `DataImportDialog`

## 23. Implementation Phases

### Phase 0: Foundation

- initialize Vite + React + TypeScript
- configure lint/format/test tooling
- add Raven design tokens and fonts
- create full-screen shell
- establish responsive CSS grid

Exit condition: static Raven HUD/sidebar/map-shell mockup accurately matches the reference information density.

### Phase 1: Map Core

- integrate MapLibre
- dark Raven map style
- search/geocoding abstraction
- map origin state
- GPS permission flow
- distance/bearing utilities
- scan radius circle/rings

Exit condition: search or geolocation can move origin and update Raven HUD/range overlays.

### Phase 2: Provider Framework

- implement provider interface
- provider registry
- normalization pipeline
- source attribution
- loading/error/partial-data states
- IndexedDB cache

Exit condition: at least one public camera dataset can populate the map and contact register through the generic provider API.

### Phase 3: Contact Register + Detail Cards

- virtualized contact list
- distance and bearing sorting
- map/list linked selection
- detailed source-aware popup/card
- classification filters

Exit condition: map and contact register are fully synchronized.

### Phase 4: Analytics + Sites

- classification counts
- nearest contact
- public-service site layer
- data health panel
- density metrics

Exit condition: right rail is driven entirely by currently loaded normalized features.

### Phase 5: Heatmap + FOV + Tactical Visualization

- density heat layer
- FOV wedges where orientation exists
- map range rings
- scan animation
- night-vis/thermal/high-contrast presentation modes
- scanline/noise effects

Exit condition: Raven visually reaches the reference dashboard's tactical feel while remaining accurate about what each visualization represents.

### Phase 6: Public Live Feeds

- live-feed provider capability
- feed browser
- map feed markers
- resilient media viewer
- jurisdiction/source metadata

Exit condition: supported public feeds can be opened directly from Raven records.

### Phase 7: On-Device Vision

- lazy model loading
- local frame processing
- anonymous object detection boxes
- performance settings
- clear AI status/legend

Exit condition: selected supported public feeds can run local anonymous object detection without sending frames to Raven servers by default.

### Phase 8: Data Import

- GeoJSON import
- CSV mapping wizard
- validation
- worker-based parsing
- user layer styling
- temporary/persistent import option

Exit condition: a user can load a large local public dataset into the same map/register architecture.

### Phase 9: Responsive + Accessibility

- tablet/mobile drawers
- bottom sheet contact details
- keyboard navigation
- focus states
- reduced-motion mode
- screen-reader labels for controls
- contrast verification

### Phase 10: Deployment

For a frontend-only first release:

- GitHub Actions build/test
- GitHub Pages deployment
- optional custom domain later

If backend provider proxies become necessary:

- deploy frontend statically
- deploy API separately
- configure environment-based API base URL
- add server-side cache/rate limiting

## 24. Testing Plan

### Unit

- distance calculation
- bearing calculation
- provider normalization
- filters/sorts
- radius inclusion
- data freshness logic

### Component

- HUD status transitions
- register/map selection synchronization
- layer toggles
- provider error states
- import validation

### End-to-end

1. open Raven
2. search a city
3. scan area
4. contacts populate
5. select contact from register
6. map focuses it
7. detail panel shows source metadata
8. enable heatmap
9. enable GPS with mocked permission
10. open public feed if available

### Performance

- 1k / 10k / 50k feature datasets
- large CSV import
- rapid map pan/zoom cancellation behavior
- memory growth over long sessions

## 25. Definition of MVP

Raven MVP is complete when it provides:

- original Raven tactical full-screen UI
- map/search
- optional geolocation
- public camera records from at least one real provider
- contact register
- selected-camera details
- scan-radius control
- rings/sites/heat toggles
- right-side classification and nearest-contact analytics
- source attribution
- local settings
- responsive mobile/tablet behavior
- no private-system access required

Live feeds and object detection can follow immediately after the MVP if they complicate initial deployment.

## 26. Recommended First Development Sprint

The first implementation sprint should focus on making Raven visually real before building every data connector.

1. Scaffold React + TypeScript + MapLibre.
2. Implement the full desktop shell at 1920x1080 and 2560x1440.
3. Reproduce the reference's panel proportions and data density with Raven branding.
4. Add a dark green custom map style.
5. Create mocked `RavenFeature` data for 100-500 contacts.
6. Wire mocked contacts into the map, left register, right classification panels, and selected-contact card.
7. Implement radius rings and bottom layer toggles.
8. Implement responsive drawers for mobile/tablet.
9. Once the UX is stable, replace mocked records with the provider framework.

This sequence makes it easy to compare Raven against the reference screenshots while keeping the visual system independent from the data-source work.

## 27. Acceptance Criteria for Visual Parity

Raven should be considered visually on target when:

- the map occupies the clear majority of the viewport
- all four HUD regions (top, left, right, bottom) remain visible without scrolling on desktop
- control labels and numeric readouts are readable at 1080p
- panels feel translucent and integrated into the map rather than like detached cards
- a dense city view can display hundreds of contacts without becoming visually unusable
- selected contacts are obvious without obscuring the map
- Raven retains the green/cyan/amber tactical aesthetic while using original Raven branding and iconography
- turning off cosmetic effects leaves a fully usable professional map dashboard

## 28. Reference Feature Summary

The source concept advertises the following high-level capabilities that Raven should use as the functional benchmark:

- global public/open-data camera mapping
- camera type/direction/address metadata where source data provides it
- optional location-awareness mode
- officially published public live webcams
- in-browser anonymous vehicle/pedestrian detection
- public-service/civic overlays
- density heatmap
- alternate visual display modes
- browser-first operation

Raven should implement these capabilities only to the extent that they can be supported accurately by open/public data sources and clearly identified presentation modes.
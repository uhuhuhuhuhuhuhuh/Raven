import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const transparentPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const pmtiles = readFileSync(fileURLToPath(new URL('./fixtures/cameras.pmtiles', import.meta.url)));

const basemapStyle = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#0c0c0c' } }]
};

/** What a deploy publishes: the OSM tile index (with vector tiles) and one JSON tile with full tags. */
const tileIndex = {
  version: 1, source: 'Geofabrik north-america/us', license: 'ODbL', dataTimestamp: '2026-10-14T20:21:02Z', tileSize: 0.5, count: 63,
  tiles: ['51_-161'], coverage: [{ hole: false, points: [[-125, 24], [-66, 24], [-66, 50], [-125, 50]] }], vectorTiles: 'cameras.pmtiles'
};
const jsonTile = [
  [901, 25.765, -80.19, { man_made: 'surveillance', name: 'Extract Tile Camera', 'camera:direction': 'NE', operator: 'City of Miami', 'camera:type': 'fixed' }],
  [902, 25.7655, -80.1905, { man_made: 'surveillance', 'surveillance:type': 'ALPR', manufacturer: 'Flock Safety' }],
  [903, 25.7645, -80.1895, { highway: 'speed_camera' }]
];
const catalog = {
  version: 1, generatedAt: '2026-10-16T06:00:00Z', count: 3,
  cameras: [
    { id: 'fl511-12064', provider: 'fl511-public-cameras', name: 'Snapshot Test Camera', lat: 25.762, lon: -80.192, direction: 'NORTHBOUND', snapshotUrl: 'https://example.test/camera.jpg', attribution: 'FL511 / Florida DOT' },
    { id: 'fl511-12065', provider: 'fl511-public-cameras', name: 'Harbor Gate Camera', lat: 25.766, lon: -80.191, operator: 'Port Authority', snapshotUrl: 'https://example.test/harbor.jpg', attribution: 'FL511 / Florida DOT' },
    { id: 'caltrans-42', provider: 'caltrans-cctv', name: 'US-101 Live Test', lat: 34.05, lon: -118.25, snapshotUrl: 'https://example.test/caltrans.jpg', stream: { url: 'https://wzmedia.dot.ca.gov/D7/TEST_CAMERA.stream/playlist.m3u8', format: 'hls' }, attribution: 'Caltrans' }
  ]
};

function isMobile(page: Page) {
  // Matches the stylesheet's phone/tablet breakpoint, where panels become bottom sheets.
  return (page.viewportSize()?.width || 1280) <= 1100;
}

/** Shows a panel: a tab-bar button on phones and tablets, a side-panel tab on desktop (cameras are always listed there). */
async function openPanel(page: Page, name: 'Cameras' | 'Overview' | 'Layers' | 'Sources') {
  if (isMobile(page)) await page.getByRole('button', { name, exact: true }).click();
  else if (name !== 'Cameras') await page.getByRole('tab', { name }).click();
}

/** Serves the published data: the catalog, and the OSM vector tiles through HTTP range requests like GitHub Pages. */
async function publishData(page: Page, options: { catalog?: boolean; tiles?: boolean } = {}) {
  if (options.catalog !== false) await page.route('**/api/v1/cameras.json', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(catalog) }));
  if (options.tiles !== false) {
    await page.route('**/api/v1/osm/index.json', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tileIndex) }));
    await page.route('**/api/v1/osm/tiles/51_-161.json', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(jsonTile) }));
    await page.route('**/api/v1/osm/cameras.pmtiles', route => {
      const match = route.request().headers().range?.match(/bytes=(\d+)-(\d+)?/);
      if (!match) return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: pmtiles, headers: { 'accept-ranges': 'bytes' } });
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), pmtiles.length - 1) : pmtiles.length - 1;
      return route.fulfill({
        status: 206,
        contentType: 'application/octet-stream',
        body: pmtiles.subarray(start, end + 1),
        headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${pmtiles.length}` }
      });
    });
  }
}

/** Counts requests to the on-demand providers, which published data makes unnecessary. */
async function countProviderRequests(page: Page) {
  const counts = { overpass: 0, fl511: 0, caltrans: 0 };
  await page.route('https://overpass-api.de/api/interpreter', route => {
    counts.overpass += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ elements: [{ type: 'node', id: 501, lat: 25.7651, lon: -80.1901, tags: { man_made: 'surveillance', name: 'Overpass Camera' } }] }) });
  });
  await page.route('**/FL511_Traffic_Cameras/FeatureServer/0/query*', route => {
    counts.fl511 += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ features: [{ geometry: { x: -80.192, y: 25.762 }, attributes: { OBJECTID_1: 1, ID: '12064', DESCRIPT: 'Provider Snapshot Camera', COUNTY: 'MIAMI-DADE', HIGHWAY: 'I-95', DIRECTION: 'NORTHBOUND', LATITUDE: 25.762, LONGITUDE: -80.192, TIMESTAMP: new Date().toISOString(), IMAGE: 'https://example.test/camera.jpg' } }], exceededTransferLimit: false }) });
  });
  await page.route('**/CHhighway/CCTV/FeatureServer/0/query*', route => {
    counts.caltrans += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"features":[],"exceededTransferLimit":false}' });
  });
  return counts;
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/health', route => route.fulfill({ status: 404, body: '{}' }));
  // Nothing published unless a test says so.
  await page.route('**/api/v1/cameras.json', route => route.fulfill({ status: 404, body: '' }));
  await page.route('**/api/v1/osm/index.json', route => route.fulfill({ status: 404, body: '' }));
  await page.route('**/api/v1/osm/changes.json', route => route.fulfill({ status: 404, body: '' }));
  await page.route('https://tile.openstreetmap.org/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: transparentPng }));
  await page.route('https://fonts.openmaptiles.org/**', route => route.fulfill({ status: 200, contentType: 'application/x-protobuf', body: Buffer.alloc(0) }));
  // A minimal stand-in for the OpenFreeMap style keeps the suite offline and deterministic.
  await page.route('https://tiles.openfreemap.org/**', route => route.fulfill({ status: 200, contentType: 'application/x-protobuf', body: Buffer.alloc(0) }));
  await page.route('https://tiles.openfreemap.org/styles/dark', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(basemapStyle) }));
  await page.route('https://example.test/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: transparentPng }));
});

test('lists live cameras from the published catalog without asking the agencies, and layers hide without losing data', async ({ page }) => {
  const counts = await countProviderRequests(page);
  await publishData(page);
  await page.goto('/');
  await expect(page.getByRole('banner')).toContainText('Raven');
  await expect(page.getByRole('status')).toHaveText('Up to date');

  await openPanel(page, 'Cameras');
  await expect(page.getByText('Snapshot Test Camera')).toBeVisible();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.waitForTimeout(900);
  expect(counts).toEqual({ overpass: 0, fl511: 0, caltrans: 0 });

  await openPanel(page, 'Layers');
  const snapshotToggle = page.getByRole('switch', { name: /^Snapshot/ });
  await snapshotToggle.click();
  await expect(snapshotToggle).toHaveAttribute('aria-checked', 'false');
  await openPanel(page, 'Cameras');
  await expect(page.getByText('Snapshot Test Camera')).toHaveCount(0);
  await openPanel(page, 'Layers');
  await page.getByRole('switch', { name: /^Snapshot/ }).click();
  await openPanel(page, 'Cameras');
  await expect(page.getByText('Snapshot Test Camera')).toBeVisible();
  expect(counts).toEqual({ overpass: 0, fl511: 0, caltrans: 0 });
});

test('renders OpenStreetMap cameras from vector tiles and fetches a record’s full tags on demand', async ({ page }) => {
  const counts = await countProviderRequests(page);
  let jsonTileRequests = 0;
  page.on('request', request => { if (request.url().endsWith('/osm/tiles/51_-161.json')) jsonTileRequests += 1; });
  await publishData(page);
  await page.goto('/#map=16.50/25.76500/-80.19000');
  await expect(page.getByRole('status')).toHaveText('Up to date');

  await openPanel(page, 'Cameras');
  const list = page.getByRole('complementary', { name: 'Contacts' });
  await expect(list.getByRole('button', { name: /Extract Tile Camera/ })).toBeVisible();
  await expect(list.getByRole('button', { name: /^Plate reader/ })).toBeVisible();
  await expect(list.getByRole('button', { name: /^Speed camera/ })).toBeVisible();
  expect(jsonTileRequests).toBe(0); // the list came from the tiles alone

  await list.getByRole('button', { name: /Extract Tile Camera/ }).click();
  if (isMobile(page)) await page.keyboard.press('Escape');
  const detail = page.locator('.detail-card');
  await expect(detail.locator('.fact', { hasText: 'Operator' })).toContainText('City of Miami');
  await expect(detail.locator('.fact', { hasText: 'Type' })).toContainText('FIXED');
  await expect(detail.locator('.detail-source')).toHaveText('© OpenStreetMap contributors · Geofabrik north-america/us, data as of 2026-10-14');
  await expect(detail.getByRole('link', { name: 'Edit on OpenStreetMap' })).toHaveAttribute('href', 'https://www.openstreetmap.org/edit?node=901');
  expect(jsonTileRequests).toBe(1);
  expect(counts.overpass).toBe(0);
});

test('shows a count instead of a list while zoomed out over the tiles', async ({ page }) => {
  await publishData(page);
  await page.goto('/#map=9.00/25.77000/-80.20000');
  await expect(page.getByRole('status')).toHaveText('Up to date');
  await openPanel(page, 'Cameras');
  await expect(page.locator('.panel-note')).toContainText(/Zoom in to list OpenStreetMap cameras · about \d+ in view/);
  await expect(page.locator('.telemetry-item', { hasText: 'In view' }).locator('strong')).toHaveText(/^≈\d+$/);
});

test('without published data it asks the providers once per area, not on every small move', async ({ page }) => {
  const counts = await countProviderRequests(page);
  await page.goto('/#map=14.00/25.76500/-80.19000');
  await expect(page.getByRole('status')).toHaveText('Up to date');
  await openPanel(page, 'Cameras');
  await expect(page.getByText('Overpass Camera')).toBeVisible();
  await expect(page.getByText('Provider Snapshot Camera')).toBeVisible();
  expect(counts).toEqual({ overpass: 1, fl511: 1, caltrans: 0 });

  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.waitForTimeout(1200);
  expect(counts).toEqual({ overpass: 1, fl511: 1, caltrans: 0 });

  await page.evaluate(() => { window.location.hash = '#map=14.00/34.05000/-118.25000'; });
  await expect.poll(() => counts.caltrans, { timeout: 25_000 }).toBeGreaterThan(0);
  expect(counts.overpass).toBe(2);
});

test('opens a shared #map link and keeps the address bar in sync with the view', async ({ page }) => {
  await page.goto('/#map=15.00/34.05000/-118.25000');
  await expect(page.locator('.telemetry-item', { hasText: 'Origin' }).locator('strong')).toHaveText('34.0500, -118.2500');
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page).toHaveURL(/#map=16\.00\/34\.050\d\d\/-118\.250\d\d$/);
});

test('copies a link to the current view', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'clipboard permissions are Chromium-only in Playwright');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/#map=15.00/34.05000/-118.25000');
  await page.getByRole('button', { name: 'Share link' }).click();
  await expect(page.getByRole('button', { name: 'Share link' })).toContainText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/#map=15\.00\/34\.05000\/-118\.25000$/);
});

test('filters the camera list, toggles a class from the legend, and closes the detail card with Escape', async ({ page }) => {
  await publishData(page, { tiles: false });
  await page.goto('/');
  await openPanel(page, 'Cameras');
  await expect(page.getByText('Snapshot Test Camera')).toBeVisible();

  await page.getByRole('searchbox', { name: 'Filter contact register' }).fill('port harbor');
  await expect(page.getByText('Snapshot Test Camera')).toHaveCount(0);
  await expect(page.locator('.contacts-count')).toHaveText('1 / 2');
  await page.getByRole('searchbox', { name: 'Filter contact register' }).fill('');

  if (isMobile(page)) await page.keyboard.press('Escape');
  const legendSnapshot = page.locator('.legend-item', { hasText: 'Snapshot' });
  await legendSnapshot.click();
  await expect(legendSnapshot).toHaveAttribute('aria-pressed', 'false');
  await openPanel(page, 'Cameras');
  await expect(page.getByText('Snapshot Test Camera')).toHaveCount(0);
  if (isMobile(page)) await page.keyboard.press('Escape');
  await legendSnapshot.click();
  await openPanel(page, 'Cameras');

  await page.getByRole('button', { name: /Harbor Gate Camera/ }).click();
  await expect(page.locator('.detail-card')).toBeVisible();
  await page.keyboard.press('Escape');
  if (isMobile(page)) await page.keyboard.press('Escape');
  await expect(page.locator('.detail-card')).toHaveCount(0);
});

test('remembers layer choices across reloads', async ({ page }) => {
  await page.goto('/');
  await openPanel(page, 'Layers');
  const heatmap = page.getByRole('switch', { name: /^Heatmap/ });
  await expect(heatmap).toHaveAttribute('aria-checked', 'false');
  await heatmap.click();
  await expect(heatmap).toHaveAttribute('aria-checked', 'true');

  await page.reload();
  await openPanel(page, 'Layers');
  await expect(page.getByRole('switch', { name: /^Heatmap/ })).toHaveAttribute('aria-checked', 'true');
});

test('renders field-of-view wedges, range rings and the heatmap without map style errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(message.text());
  });
  await publishData(page);
  await page.goto('/#map=16.50/25.76500/-80.19000');
  await expect(page.getByRole('status')).toHaveText('Up to date');

  await openPanel(page, 'Layers');
  await expect(page.getByRole('switch', { name: /^Field of view/ })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('switch', { name: /^Range rings/ }).click();
  await page.getByRole('switch', { name: /^Heatmap/ }).click();
  await page.getByRole('switch', { name: /^Plate reader/ }).click();
  await expect(page.getByRole('switch', { name: /^Range rings/ })).toHaveAttribute('aria-checked', 'true');
  await page.waitForTimeout(600);
  expect(errors).toEqual([]);
});

test('plays a catalog HLS stream in-app and falls back to the snapshot when it fails', async ({ page }) => {
  const playlist = 'https://wzmedia.dot.ca.gov/D7/TEST_CAMERA.stream/playlist.m3u8';
  let playlistRequests = 0;
  await publishData(page, { tiles: false });
  // An unplayable stream: this proves hls.js requests the published playlist and that failure degrades cleanly.
  await page.route(playlist, route => {
    playlistRequests += 1;
    return route.fulfill({ status: 404, body: 'gone' });
  });

  await page.goto('/#map=14.00/34.05000/-118.25000');
  await openPanel(page, 'Cameras');
  await page.getByRole('button', { name: /US-101 Live Test/ }).click();
  if (isMobile(page)) await page.keyboard.press('Escape');

  const detail = page.locator('.detail-card');
  await expect(detail.getByText('Public HLS stream')).toBeVisible();
  await expect(detail.getByText('Stream unavailable')).toBeVisible();
  expect(playlistRequests).toBeGreaterThan(0);
  await expect(detail.getByRole('img', { name: /Public traffic camera snapshot/ })).toBeVisible();

  const before = playlistRequests;
  await detail.getByRole('button', { name: 'Retry live stream' }).click();
  await expect(detail.getByText('Stream unavailable')).toBeVisible();
  expect(playlistRequests).toBeGreaterThan(before);
});

test('shows cameras newly mapped since the last weekly extract', async ({ page }) => {
  await page.route('**/api/v1/osm/changes.json', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      version: 1, baseline: false, since: '2026-10-07T20:00:00Z', until: '2026-10-14T20:21:02Z', addedCount: 2, removedCount: 1,
      added: [[5, 25.765, -80.19, { man_made: 'surveillance' }], [6, 25.766, -80.191, { man_made: 'surveillance', 'surveillance:type': 'ALPR' }]],
      removed: [[9, 25.7, -80.2, {}]], feed: 'changes.atom'
    })
  }));
  await page.goto('/');
  await openPanel(page, 'Overview');
  const card = page.locator('.stat-card', { hasText: 'Newly mapped' });
  await expect(card.locator('strong')).toHaveText('+2');
  await expect(card).toContainText('1 removed · 2026-10-07 → 2026-10-14');
  await expect(card.getByRole('link', { name: 'Atom feed' })).toHaveAttribute('href', /\/api\/v1\/osm\/changes\.atom$/);
  await openPanel(page, 'Layers');
  await expect(page.getByRole('switch', { name: /^Newly mapped/ })).toHaveAttribute('aria-checked', 'true');
});

test('exports the listed cameras as GeoJSON, with OSM records linked to the editor', async ({ page }) => {
  await publishData(page);
  await page.goto('/#map=16.50/25.76500/-80.19000');
  await expect(page.getByRole('status')).toHaveText('Up to date');
  await openPanel(page, 'Cameras');
  await expect(page.getByRole('button', { name: /Extract Tile Camera/ })).toBeVisible();
  if (isMobile(page)) await page.keyboard.press('Escape');

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export GeoJSON' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^raven-cameras-\d{4}-\d{2}-\d{2}\.geojson$/);
  const collection = JSON.parse(await (await download.createReadStream()).toArray().then(chunks => Buffer.concat(chunks).toString('utf8')));
  expect(collection.type).toBe('FeatureCollection');
  expect(collection.attribution).toEqual(expect.arrayContaining([expect.stringContaining('© OpenStreetMap contributors')]));
  const ids = collection.features.map((feature: { id: string }) => feature.id);
  expect(ids).toEqual(expect.arrayContaining(['osm-node-901', 'osm-node-902', 'osm-node-903', 'fl511-12065']));
  await expect(page.getByRole('link', { name: 'Add camera to OSM' })).toHaveAttribute('href', /openstreetmap\.org\/edit#map=19\//);
});

test('lists the data sets and their freshness', async ({ page }) => {
  await publishData(page);
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('Up to date');
  await openPanel(page, 'Sources');
  await expect(page.locator('.source-row', { hasText: 'Live traffic cameras' })).toContainText(/Published catalog · FL511.*Caltrans.* · 2026-10-16/);
  await expect(page.locator('.source-row', { hasText: 'OpenStreetMap cameras' })).toContainText('Vector tiles from the Geofabrik north-america/us · 2026-10-14');
  await expect(page.locator('.telemetry-item', { hasText: 'Data' }).locator('strong')).toHaveText('2026-10-14');
});

test('keeps the app chrome within the screen so the map never resizes', async ({ page }) => {
  await publishData(page);
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('Up to date');
  // Chrome wider than a phone screen makes mobile browsers zoom the page out, which resizes the map.
  const overflow = await page.evaluate(() => [...document.querySelectorAll('.topbar, .topbar *, .dock, .dock *, .mobile-tabs *')]
    .filter(element => element.getClientRects().length > 0)
    .map(element => ({ element: String(element.className || element.tagName), box: element.getBoundingClientRect() }))
    .filter(({ box }) => box.left < -0.5 || box.right > window.innerWidth + 0.5)
    .map(({ element, box }) => `${element} ${Math.round(box.left)}..${Math.round(box.right)}`));
  expect(overflow).toEqual([]);
  expect(await page.evaluate(() => (document.querySelector('.maplibregl-canvas') as HTMLElement).clientWidth)).toBe(await page.evaluate(() => window.innerWidth));
});

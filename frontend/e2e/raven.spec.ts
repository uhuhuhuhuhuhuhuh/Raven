import { expect, test, type Page } from '@playwright/test';

const transparentPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

const basemapStyle = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#0c0c0c' } }]
};

function isMobile(page: Page) {
  return (page.viewportSize()?.width || 1000) <= 900;
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/health', route => route.fulfill({ status: 404, body: '{}' }));
  // No extract tiles unless a test publishes some; keeps scans off the dev server's /api proxy.
  await page.route('**/api/v1/osm/index.json', route => route.fulfill({ status: 404, body: '' }));
  await page.route('**/api/v1/osm/changes.json', route => route.fulfill({ status: 404, body: '' }));
  await page.route('https://tile.openstreetmap.org/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: transparentPng }));
  await page.route('https://fonts.openmaptiles.org/**', route => route.fulfill({ status: 200, contentType: 'application/x-protobuf', body: Buffer.alloc(0) }));
  // A minimal stand-in for the OpenFreeMap style keeps the suite offline and deterministic.
  await page.route('https://tiles.openfreemap.org/**', route => route.fulfill({ status: 200, contentType: 'application/x-protobuf', body: Buffer.alloc(0) }));
  await page.route('https://tiles.openfreemap.org/styles/dark', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(basemapStyle) }));
});

test('snapshot layers hide and restore without destructive data loss', async ({ page }) => {
  let providerRequests = 0;

  await page.route('https://overpass-api.de/api/interpreter', async route => {
    providerRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        elements: [{
          type: 'node', id: 101, lat: 25.765, lon: -80.190,
          tags: { man_made: 'surveillance', name: 'Mapped Test Camera', 'camera:type': 'fixed' }
        }]
      })
    });
  });

  await page.route('**/FL511_Traffic_Cameras/FeatureServer/0/query*', async route => {
    providerRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        features: [{
          geometry: { x: -80.192, y: 25.762 },
          attributes: {
            OBJECTID_1: 1,
            ID: '12064',
            DESCRIPT: 'Snapshot Test Camera',
            COUNTY: 'MIAMI-DADE',
            HIGHWAY: 'I-95',
            DIRECTION: 'NORTHBOUND',
            LATITUDE: 25.762,
            LONGITUDE: -80.192,
            TIMESTAMP: new Date().toISOString(),
            IMAGE: 'https://example.test/camera.jpg'
          }
        }],
        exceededTransferLimit: false
      })
    });
  });

  await page.goto('/');
  await expect(page.getByText('RAVEN', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'SCAN VIEW' }).click();

  if (isMobile(page)) {
    await page.getByRole('button', { name: 'CONTACTS', exact: true }).click();
  }
  await expect(page.getByText('Snapshot Test Camera')).toBeVisible();
  await expect(page.getByText('Mapped Test Camera')).toBeVisible();
  expect(providerRequests).toBe(2);

  if (isMobile(page)) {
    await page.getByRole('button', { name: 'LAYERS', exact: true }).click();
  }

  const snapshotToggle = page.getByRole('button', { name: /TRAFFIC SNAPSHOTS/ });
  await expect(snapshotToggle).toHaveAttribute('aria-pressed', 'true');
  await snapshotToggle.click();
  await expect(snapshotToggle).toHaveAttribute('aria-pressed', 'false');

  if (isMobile(page)) {
    await page.getByRole('button', { name: 'CONTACTS', exact: true }).click();
  }
  await expect(page.getByText('Snapshot Test Camera')).toHaveCount(0);
  await expect(page.getByText('Mapped Test Camera')).toBeVisible();

  if (isMobile(page)) {
    await page.getByRole('button', { name: 'LAYERS', exact: true }).click();
  }
  await page.getByRole('button', { name: /TRAFFIC SNAPSHOTS/ }).click();
  expect(providerRequests).toBe(2);

  if (isMobile(page)) {
    await page.getByRole('button', { name: 'CONTACTS', exact: true }).click();
  }
  await expect(page.getByText('Snapshot Test Camera')).toBeVisible();
});

test('moving the map marks completed results stale', async ({ page }) => {
  await page.route('https://overpass-api.de/api/interpreter', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"elements":[]}' }));
  await page.route('**/FL511_Traffic_Cameras/FeatureServer/0/query*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"features":[],"exceededTransferLimit":false}' }));
  await page.goto('/');
  await page.getByRole('button', { name: 'SCAN VIEW' }).click();
  await expect(page.getByText('● READY')).toBeVisible();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.getByText(/RESULTS ARE FROM THE PREVIOUS SCAN/)).toBeVisible();
});

test('upgrades an existing v1 provider cache and prunes expired entries', async ({ page }) => {
  await page.route('https://overpass-api.de/api/interpreter', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"elements":[]}' }));
  await page.route('**/FL511_Traffic_Cameras/FeatureServer/0/query*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"features":[],"exceededTransferLimit":false}' }));
  await page.goto('/');

  // Recreate the cache exactly as Raven 1.1 (schema v1, no savedAt index) left it.
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('raven-provider-cache', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('providerScans', { keyPath: 'key' });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('providerScans', 'readwrite');
      const store = transaction.objectStore('providerScans');
      const record = { providerId: 'legacy', bounds: { west: 0, south: 0, east: 1, north: 1 }, features: [] };
      store.put({ ...record, key: 'legacy:expired', savedAt: Date.now() - 2 * 60 * 60 * 1000 });
      store.put({ ...record, key: 'legacy:recent', savedAt: Date.now() - 1000 });
      transaction.oncomplete = () => { database.close(); resolve(); };
    };
  }));

  await page.getByRole('button', { name: 'SCAN VIEW' }).click();
  await expect(page.getByText('● READY')).toBeVisible();

  const readCache = () => page.evaluate(() => new Promise<{ version: number; indexes: string[]; keys: string[] }>((resolve, reject) => {
    const request = indexedDB.open('raven-provider-cache');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const store = database.transaction('providerScans', 'readonly').objectStore('providerScans');
      const keys = store.getAllKeys();
      keys.onsuccess = () => {
        const result = { version: database.version, indexes: Array.from(store.indexNames), keys: keys.result.map(String) };
        database.close();
        resolve(result);
      };
    };
  }));

  await expect.poll(async () => (await readCache()).keys.some(key => key.startsWith('osm-overpass:'))).toBe(true);
  const cache = await readCache();
  expect(cache.version).toBe(2);
  expect(cache.indexes).toContain('savedAt');
  expect(cache.keys).toContain('legacy:recent');
  expect(cache.keys).not.toContain('legacy:expired');
});

async function routeCameras(page: Page, elements: object[]) {
  await page.route('https://overpass-api.de/api/interpreter', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ elements }) }));
  await page.route('**/FL511_Traffic_Cameras/FeatureServer/0/query*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"features":[],"exceededTransferLimit":false}' }));
}

async function openPanel(page: Page, name: 'CONTACTS' | 'LAYERS') {
  if (isMobile(page)) await page.getByRole('button', { name, exact: true }).click();
}

test('opens a shared #map link and keeps the address bar in sync with the view', async ({ page }) => {
  await page.goto('/#map=15.00/34.05000/-118.25000');
  await expect(page.locator('.hud-metric', { hasText: 'REFERENCE ORIGIN' }).locator('strong')).toHaveText('34.0500, -118.2500');
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page).toHaveURL(/#map=16\.00\/34\.050\d\d\/-118\.250\d\d$/);
});

test('filters the contact register and closes the detail card with Escape', async ({ page }) => {
  await routeCameras(page, [
    { type: 'node', id: 1, lat: 25.765, lon: -80.190, tags: { man_made: 'surveillance', name: 'Main St Camera' } },
    { type: 'node', id: 2, lat: 25.766, lon: -80.191, tags: { man_made: 'surveillance', name: 'Harbor Gate Camera', operator: 'Port Authority' } }
  ]);
  await page.goto('/');
  await page.getByRole('button', { name: 'SCAN VIEW' }).click();
  await openPanel(page, 'CONTACTS');
  await expect(page.getByText('Main St Camera')).toBeVisible();

  await page.getByRole('searchbox', { name: 'Filter contact register' }).fill('port harbor');
  await expect(page.getByText('Main St Camera')).toHaveCount(0);
  await expect(page.locator('.contact-register .panel-title small')).toHaveText('1 / 2 VISIBLE');

  await page.getByRole('button', { name: /Harbor Gate Camera/ }).click();
  await expect(page.locator('.detail-card')).toBeVisible();
  await page.keyboard.press('Escape');
  if (isMobile(page)) await page.keyboard.press('Escape');
  await expect(page.locator('.detail-card')).toHaveCount(0);
});

test('remembers layer choices across reloads', async ({ page }) => {
  await page.goto('/');
  await openPanel(page, 'LAYERS');
  const heatmap = page.getByRole('button', { name: /HEATMAP/ });
  await expect(heatmap).toHaveAttribute('aria-pressed', 'false');
  await heatmap.click();
  await expect(heatmap).toHaveAttribute('aria-pressed', 'true');

  await page.reload();
  await openPanel(page, 'LAYERS');
  await expect(page.getByRole('button', { name: /HEATMAP/ })).toHaveAttribute('aria-pressed', 'true');
});

test('renders field-of-view wedges and range rings without map style errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(message.text());
  });
  await routeCameras(page, [
    { type: 'node', id: 7, lat: 25.765, lon: -80.190, tags: { man_made: 'surveillance', name: 'Facing Camera', 'camera:direction': 'NE' } }
  ]);
  await page.goto('/#map=16.50/25.76500/-80.19000');
  await page.getByRole('button', { name: 'SCAN VIEW' }).click();
  await expect(page.getByText('● READY')).toBeVisible();

  await openPanel(page, 'LAYERS');
  await expect(page.getByRole('button', { name: /FIELD OF VIEW/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: /RANGE RINGS/ }).click();
  await expect(page.getByRole('button', { name: /RANGE RINGS/ })).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(500);
  expect(errors).toEqual([]);
});

test('plays a provider-published HLS stream in-app and falls back to the snapshot when it fails', async ({ page }) => {
  const playlist = 'https://wzmedia.dot.ca.gov/D7/TEST_CAMERA.stream/playlist.m3u8';
  let playlistRequests = 0;
  await routeCameras(page, []);
  await page.route('**/CHhighway/CCTV/FeatureServer/0/query*', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      features: [{
        geometry: { x: -118.25, y: 34.05 },
        attributes: { OBJECTID: 42, locationName: 'US-101 Live Test', inService: 'true', streamingVideoURL: playlist, currentImageURL: 'https://example.test/caltrans.jpg' }
      }],
      exceededTransferLimit: false
    })
  }));
  await page.route('https://example.test/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: transparentPng }));
  // An unplayable stream: this proves hls.js requests the published playlist and that failure degrades cleanly.
  await page.route(playlist, route => {
    playlistRequests += 1;
    return route.fulfill({ status: 404, body: 'gone' });
  });

  await page.goto('/#map=14.00/34.05000/-118.25000');
  await page.getByRole('button', { name: 'SCAN VIEW' }).click();
  await openPanel(page, 'CONTACTS');
  await page.getByRole('button', { name: /US-101 Live Test/ }).click();
  if (isMobile(page)) await page.keyboard.press('Escape');

  const detail = page.locator('.detail-card');
  await expect(detail.getByText('PUBLIC HLS STREAM')).toBeVisible();
  await expect(detail.getByText('● STREAM UNAVAILABLE')).toBeVisible();
  expect(playlistRequests).toBeGreaterThan(0);
  await expect(detail.getByRole('img', { name: /Public traffic camera snapshot/ })).toBeVisible();

  const before = playlistRequests;
  await detail.getByRole('button', { name: 'RETRY LIVE STREAM' }).click();
  await expect(detail.getByText('● STREAM UNAVAILABLE')).toBeVisible();
  expect(playlistRequests).toBeGreaterThan(before);
});

test('reads published Geofabrik extract tiles instead of querying Overpass', async ({ page }) => {
  let overpassRequests = 0;
  await page.route('https://overpass-api.de/api/interpreter', route => {
    overpassRequests += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"elements":[]}' });
  });
  await page.route('**/FL511_Traffic_Cameras/FeatureServer/0/query*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"features":[]}' }));
  await page.route('**/api/v1/osm/index.json', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      version: 1, source: 'Geofabrik north-america/us', license: 'ODbL', dataTimestamp: '2026-09-22T20:21:02Z', tileSize: 0.5, count: 1,
      tiles: ['51_-161'], coverage: [{ hole: false, points: [[-125, 24], [-66, 24], [-66, 50], [-125, 50]] }]
    })
  }));
  await page.route('**/api/v1/osm/tiles/51_-161.json', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify([[901, 25.765, -80.19, { man_made: 'surveillance', name: 'Extract Tile Camera' }]])
  }));

  await page.goto('/');
  await page.getByRole('button', { name: 'SCAN VIEW' }).click();
  await openPanel(page, 'CONTACTS');
  await page.getByRole('button', { name: /Extract Tile Camera/ }).click();
  if (isMobile(page)) await page.keyboard.press('Escape');
  await expect(page.locator('.detail-source')).toHaveText('© OpenStreetMap contributors · Geofabrik north-america/us, data as of 2026-09-22');
  expect(overpassRequests).toBe(0);
});

test('shows cameras newly mapped since the last weekly extract', async ({ page }) => {
  await page.route('**/api/v1/osm/changes.json', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      version: 1, baseline: false, since: '2026-09-15T20:00:00Z', until: '2026-09-22T20:21:02Z', addedCount: 2, removedCount: 1,
      added: [[5, 25.765, -80.19, { man_made: 'surveillance' }], [6, 25.766, -80.191, { man_made: 'surveillance', 'surveillance:type': 'ALPR' }]],
      removed: [[9, 25.7, -80.2, {}]], feed: 'changes.atom'
    })
  }));
  await page.goto('/');
  await openPanel(page, 'LAYERS');
  const card = page.locator('.analytics-card', { hasText: 'NEWLY MAPPED · OSM' });
  await expect(card.locator('strong')).toHaveText('+2');
  await expect(card).toContainText('1 REMOVED · 2026-09-15 → 2026-09-22');
  await expect(card.getByRole('link', { name: 'ATOM FEED ↗' })).toHaveAttribute('href', /\/api\/v1\/osm\/changes\.atom$/);
  await expect(page.getByRole('button', { name: /NEWLY MAPPED/ })).toHaveAttribute('aria-pressed', 'true');
});

test('exports the visible cameras as GeoJSON and links OSM records to the editor', async ({ page }) => {
  await routeCameras(page, [
    { type: 'node', id: 77, lat: 25.765, lon: -80.190, tags: { man_made: 'surveillance', 'surveillance:type': 'ALPR', name: 'Export Plate Reader' } }
  ]);
  await page.goto('/');
  await page.getByRole('button', { name: 'SCAN VIEW' }).click();
  await expect(page.locator('.system-block strong')).toHaveText(/READY/);

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'EXPORT GEOJSON' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^raven-cameras-\d{4}-\d{2}-\d{2}\.geojson$/);
  const collection = JSON.parse(await (await download.createReadStream()).toArray().then(chunks => Buffer.concat(chunks).toString('utf8')));
  expect(collection.type).toBe('FeatureCollection');
  expect(collection.attribution).toContain('© OpenStreetMap contributors');
  expect(collection.features).toEqual([expect.objectContaining({ id: 'osm-node-77', geometry: { type: 'Point', coordinates: [-80.19, 25.765] } })]);

  await expect(page.getByRole('link', { name: 'ADD CAMERA TO OSM ↗' })).toHaveAttribute('href', /openstreetmap\.org\/edit#map=19\//);
  await openPanel(page, 'CONTACTS');
  await page.getByRole('button', { name: /Export Plate Reader/ }).click();
  if (isMobile(page)) await page.keyboard.press('Escape');
  await expect(page.getByRole('link', { name: 'EDIT ON OPENSTREETMAP ↗' })).toHaveAttribute('href', 'https://www.openstreetmap.org/edit?node=77');
});

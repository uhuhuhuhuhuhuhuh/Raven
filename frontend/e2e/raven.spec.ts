import { expect, test, type Page } from '@playwright/test';

const transparentPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function isMobile(page: Page) {
  return (page.viewportSize()?.width || 1000) <= 900;
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/health', route => route.fulfill({ status: 404, body: '{}' }));
  await page.route('https://tile.openstreetmap.org/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: transparentPng }));
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

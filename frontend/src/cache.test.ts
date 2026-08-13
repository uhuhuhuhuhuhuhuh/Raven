import { beforeEach, describe, expect, it } from 'vitest';
import { clearProviderCache, getCachedProviderScan, providerCacheKey, putCachedProviderScan } from './cache';
import type { RavenFeature } from './types';

const bounds = { west: -80.3, south: 25.7, east: -80.1, north: 25.9 };
const feature: RavenFeature = {
  id: 'cached-1', providerId: 'test-provider', kind: 'camera', cameraType: 'fixed', mediaType: 'snapshot',
  name: 'Cached Camera', lat: 25.76, lon: -80.19, snapshotUrl: 'https://example.test/cache.jpg',
  fetchedAt: new Date().toISOString(), metadata: {}
};

beforeEach(async () => clearProviderCache());

describe('provider cache', () => {
  it('uses a deterministic provider plus bounds key', () => {
    expect(providerCacheKey('test-provider', bounds)).toBe('test-provider:-80.3000:25.7000:-80.1000:25.9000');
  });

  it('round-trips provider results through the browser-cache fallback', async () => {
    await putCachedProviderScan('test-provider', bounds, [feature], 2);
    const cached = await getCachedProviderScan('test-provider', bounds, 60_000);
    expect(cached?.features).toEqual([feature]);
    expect(cached?.pages).toBe(2);
  });

  it('returns no entry after the cache is cleared', async () => {
    await putCachedProviderScan('test-provider', bounds, [feature]);
    await clearProviderCache();
    expect(await getCachedProviderScan('test-provider', bounds, 60_000)).toBeNull();
  });
});

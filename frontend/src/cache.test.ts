import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearProviderCache, getCachedProviderScan, providerCacheKey, putCachedProviderScan, selectEvictions } from './cache';
import type { RavenFeature } from './types';

const bounds = { west: -80.3, south: 25.7, east: -80.1, north: 25.9 };
const feature: RavenFeature = {
  id: 'cached-1', providerId: 'test-provider', kind: 'camera', cameraType: 'fixed', mediaType: 'snapshot',
  name: 'Cached Camera', lat: 25.76, lon: -80.19, snapshotUrl: 'https://example.test/cache.jpg',
  fetchedAt: new Date().toISOString(), metadata: {}
};

beforeEach(async () => clearProviderCache());
afterEach(() => vi.useRealTimers());

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

  it('evicts expired entries first, then the oldest entries beyond the cap', () => {
    const now = 1_000_000;
    const entries = [
      { key: 'expired', savedAt: now - 10_000 },
      { key: 'oldest-live', savedAt: now - 3_000 },
      { key: 'middle', savedAt: now - 2_000 },
      { key: 'newest', savedAt: now - 1_000 }
    ];
    expect(selectEvictions(entries, now, 5_000, 10)).toEqual(['expired']);
    expect(selectEvictions(entries, now, 5_000, 2)).toEqual(['expired', 'oldest-live']);
    expect(selectEvictions([], now, 5_000, 2)).toEqual([]);
  });

  it('bounds the in-memory fallback so long auto-scan sessions cannot grow without limit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.parse('2026-01-01T00:00:00Z');
    for (let index = 0; index < 30; index += 1) {
      vi.setSystemTime(start + index * 1000);
      await putCachedProviderScan('test-provider', { ...bounds, west: bounds.west - index }, [feature]);
    }
    expect(await getCachedProviderScan('test-provider', { ...bounds, west: bounds.west - 0 }, 60 * 60 * 1000)).toBeNull();
    expect(await getCachedProviderScan('test-provider', { ...bounds, west: bounds.west - 29 }, 60 * 60 * 1000)).not.toBeNull();
  });
});

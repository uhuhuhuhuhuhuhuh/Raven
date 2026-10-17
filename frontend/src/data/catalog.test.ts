import { describe, expect, it, vi } from 'vitest';
import { loadCatalog, parseCatalog } from './catalog';
import { filterByBounds, boundsContain, padBounds } from './bounds';

const payload = {
  version: 1,
  generatedAt: '2026-10-16T06:00:00Z',
  count: 2,
  cameras: [
    { id: 'fl511-1', provider: 'fl511', name: 'I-95 at NW 79th', lat: 25.85, lon: -80.2, snapshotUrl: 'https://example.test/1.jpg', attribution: 'FL511' },
    { id: 'caltrans-2', provider: 'caltrans', name: 'US-101', lat: 34.05, lon: -118.25, stream: { url: 'https://example.test/a.m3u8', format: 'hls', online: true } },
    { id: 7, provider: 'bad', name: 'no id', lat: 0, lon: 0 }
  ]
};

describe('catalog', () => {
  it('turns published records into features with the right media type', () => {
    const catalog = parseCatalog(payload)!;
    expect(catalog.features.map(feature => [feature.id, feature.mediaType])).toEqual([['fl511-1', 'snapshot'], ['caltrans-2', 'stream']]);
    expect(catalog.features[1].streamUrl).toBe('https://example.test/a.m3u8');
    expect(catalog.features[1].metadata).toEqual({ streamFormat: 'hls', streamOnline: true });
    expect(catalog.providers).toEqual(['fl511', 'caltrans']);
    expect(catalog.generatedAt).toBe('2026-10-16T06:00:00Z');
  });

  it('rejects unknown shapes and missing files', async () => {
    expect(parseCatalog({ version: 2 })).toBeNull();
    const missing = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response('', { status: 404 }));
    expect(await loadCatalog('https://raven.test/api/v1/', undefined, missing as typeof fetch)).toBeNull();
    expect(String(missing.mock.calls[0][0])).toBe('https://raven.test/api/v1/cameras.json');
  });

  it('filters by viewport', () => {
    const catalog = parseCatalog(payload)!;
    expect(filterByBounds(catalog.features, { west: -81, south: 25, east: -80, north: 26 }).map(feature => feature.id)).toEqual(['fl511-1']);
  });
});

describe('bounds', () => {
  it('pads and contains', () => {
    const view = { west: -80.3, south: 25.7, east: -80.1, north: 25.8 };
    const padded = padBounds(view, 0.25);
    expect(padded.west).toBeCloseTo(-80.35);
    expect(padded.south).toBeCloseTo(25.675);
    expect(padded.east).toBeCloseTo(-80.05);
    expect(padded.north).toBeCloseTo(25.825);
    expect(boundsContain(padded, view)).toBe(true);
    expect(boundsContain(view, padded)).toBe(false);
  });
});

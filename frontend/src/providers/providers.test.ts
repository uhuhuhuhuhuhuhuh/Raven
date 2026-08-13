import { afterEach, describe, expect, it, vi } from 'vitest';
import { fl511Provider } from './fl511';
import { osmProvider } from './osm';

const bounds = { west: -80.3, south: 25.7, east: -80.1, north: 25.9 };

afterEach(() => vi.unstubAllGlobals());

describe('camera providers', () => {
  it('queries OSM using the exact visible bounding box', async () => {
    let queryText = '';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      queryText = new URLSearchParams(String(init?.body || '')).get('data') || '';
      return new Response(JSON.stringify({ elements: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));

    await osmProvider.scan({ mode: 'static', bounds }, new AbortController().signal);
    expect(queryText).toContain('(25.7,-80.3,25.9,-80.1)');
  });

  it('paginates FL511 when ArcGIS reports an exceeded transfer limit', async () => {
    const offsets: string[] = [];
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const parsed = new URL(url);
      offsets.push(parsed.searchParams.get('resultOffset') || '');
      call += 1;
      const feature = {
        geometry: { x: -80.19 + call / 1000, y: 25.76 },
        attributes: {
          OBJECTID_1: call,
          ID: String(call),
          DESCRIPT: `Camera ${call}`,
          COUNTY: 'MIAMI-DADE',
          HIGHWAY: 'I-95',
          DIRECTION: 'NORTHBOUND',
          LATITUDE: 25.76,
          LONGITUDE: -80.19 + call / 1000,
          TIMESTAMP: '2026-08-13T08:00:00Z',
          IMAGE: `https://example.test/${call}.jpg`
        }
      };
      return new Response(JSON.stringify({ features: [feature], exceededTransferLimit: call === 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }));

    const result = await fl511Provider.scan({ mode: 'static', bounds }, new AbortController().signal);
    expect(result.features).toHaveLength(2);
    expect(result.pages).toBe(2);
    expect(offsets).toEqual(['0', '2000']);
    expect(result.features[0].mediaType).toBe('snapshot');
    expect(result.features[0].directionLabel).toBe('NORTHBOUND');
    expect(result.features[0].streamUrl).toBeUndefined();
  });
});

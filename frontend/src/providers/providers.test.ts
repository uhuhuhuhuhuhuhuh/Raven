import { afterEach, describe, expect, it, vi } from 'vitest';
import { caltransProvider } from './caltrans';
import { fl511Provider } from './fl511';
import { osmProvider, tileBounds } from './osm';

const floridaBounds = { west: -80.3, south: 25.7, east: -80.1, north: 25.9 };
const californiaBounds = { west: -118.6, south: 33.8, east: -118.0, north: 34.2 };

afterEach(() => vi.unstubAllGlobals());

describe('camera providers', () => {
  it('queries OSM using the exact visible bounding box', async () => {
    let queryText = '';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      queryText = new URLSearchParams(String(init?.body || '')).get('data') || '';
      return new Response(JSON.stringify({ elements: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));

    await osmProvider.scan({ mode: 'static', bounds: floridaBounds, zoom: 13 }, new AbortController().signal);
    expect(queryText).toContain('(25.7,-80.3,25.9,-80.1)');
  });

  it('splits broad OSM views into bounded progressive tiles', async () => {
    const broad = { west: -82.5, south: 24.5, east: -79.5, north: 27.5 };
    const tiles = tileBounds(broad);
    expect(tiles.length).toBeGreaterThan(1);
    expect(tiles.length).toBeLessThanOrEqual(24);
    const progress: Array<[number, number]> = [];
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      return new Response(JSON.stringify({ elements: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    await osmProvider.scan({
      mode: 'static', bounds: broad, zoom: 8,
      onProgress: (_features, state) => progress.push([state.completed, state.total])
    }, new AbortController().signal);
    expect(calls).toBe(tiles.length);
    expect(progress.at(-1)).toEqual([tiles.length, tiles.length]);
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

    const result = await fl511Provider.scan({ mode: 'static', bounds: floridaBounds, zoom: 13 }, new AbortController().signal);
    expect(result.features).toHaveLength(2);
    expect(result.pages).toBe(2);
    expect(offsets).toEqual(['0', '2000']);
    expect(result.features[0].mediaType).toBe('snapshot');
    expect(result.features[0].directionLabel).toBe('NORTHBOUND');
    expect(result.features[0].streamUrl).toBeUndefined();
  });

  it('normalizes Caltrans snapshot plus official streaming viewer without inventing a direct stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      features: [{
        geometry: { x: -118.25, y: 34.05 },
        attributes: {
          OBJECTID: 42,
          index_: 42,
          recordEpoch: 1786610000,
          district: 7,
          locationName: 'US-101 TEST CAMERA',
          longitude: -118.25,
          latitude: 34.05,
          direction: 'N',
          county: 'Los Angeles',
          route: 'US-101',
          inService: 'true',
          imageDescription: 'Test camera',
          streamingVideoURL: 'https://cwwp2.dot.ca.gov/vm/loc/d7/test.htm',
          currentImageUpdateFrequency: 5,
          currentImageURL: 'https://example.test/caltrans.jpg'
        }
      }],
      exceededTransferLimit: false
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const result = await caltransProvider.scan({ mode: 'static', bounds: californiaBounds, zoom: 13 }, new AbortController().signal);
    expect(result.features).toHaveLength(1);
    expect(result.features[0].mediaType).toBe('stream');
    expect(result.features[0].snapshotUrl).toBe('https://example.test/caltrans.jpg');
    expect(result.features[0].streamPageUrl).toContain('cwwp2.dot.ca.gov');
    expect(result.features[0].streamUrl).toBeUndefined();
    expect(result.features[0].operator).toBe('Caltrans');
  });
});

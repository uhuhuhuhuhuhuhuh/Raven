import { afterEach, describe, expect, it, vi } from 'vitest';
import { osmProvider } from './osm';
import { boundsCovered, coverageContains, parseTileIndex, tileKeysFor, type OsmTileIndex } from './osmTiles';

afterEach(() => vi.unstubAllGlobals());

const florida: OsmTileIndex['coverage'] = [
  { hole: false, points: [[-87.7, 24.3], [-79.7, 24.3], [-79.7, 31.2], [-87.7, 31.2]] },
  { hole: true, points: [[-81, 26], [-80.5, 26], [-80.5, 26.5], [-81, 26.5]] }
];
const index: OsmTileIndex = {
  version: 1, source: 'Geofabrik north-america/us/florida', license: 'ODbL', dataTimestamp: '2026-09-22T20:21:02Z',
  tileSize: 0.5, count: 3, tiles: ['51_-161', '51_-160'], coverage: florida
};
const miami = { west: -80.3, south: 25.7, east: -80.1, north: 25.9 };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('OSM extract coverage and tiling', () => {
  it('tests points against outer rings, holes and antimeridian-drawn rings', () => {
    expect(coverageContains(florida, -80.19, 25.76)).toBe(true);
    expect(coverageContains(florida, -80.75, 26.25)).toBe(false);
    expect(coverageContains(florida, -74, 40.7)).toBe(false);
    const aleutians = [{ hole: false, points: [[170, 50], [190, 50], [190, 55], [170, 55]] as Array<[number, number]> }];
    expect(coverageContains(aleutians, -175, 52)).toBe(true);
  });

  it('only treats a scan as covered when the whole box is inside', () => {
    expect(boundsCovered(florida, miami)).toBe(true);
    expect(boundsCovered(florida, { west: -80, south: 25.7, east: -79.5, north: 25.9 })).toBe(false);
    // Every corner and edge midpoint is covered, but the hole sits inside the box.
    expect(boundsCovered(florida, { west: -81.2, south: 25.8, east: -80.2, north: 26.8 })).toBe(false);
  });

  it('catches a boundary notch that reaches into the box between its corners', () => {
    const notched = [{ hole: false, points: [[0, 0], [10, 0], [10, 10], [5.5, 10], [5, 4], [4.5, 10], [0, 10]] as Array<[number, number]> }];
    expect(boundsCovered(notched, { west: 1, south: 1, east: 9, north: 3 })).toBe(true);
    expect(boundsCovered(notched, { west: 1, south: 1, east: 9, north: 6 })).toBe(false);
  });

  it('lists every tile a box touches, flooring negative coordinates', () => {
    expect(tileKeysFor(miami, 0.5)).toEqual(['51_-161']);
    expect(tileKeysFor({ west: -0.2, south: -0.2, east: 0.2, north: 0.2 }, 0.5)).toEqual(['-1_-1', '-1_0', '0_-1', '0_0']);
  });

  it('rejects indexes of an unknown version or shape', () => {
    expect(parseTileIndex(index)).toBe(index);
    expect(parseTileIndex({ ...index, version: 2 })).toBeNull();
    expect(parseTileIndex({ ...index, tileSize: 0 })).toBeNull();
    expect(parseTileIndex({ ...index, coverage: [] })).toBeNull();
    expect(parseTileIndex('<!doctype html>')).toBeNull();
  });
});

describe('OSM provider with published extract tiles', () => {
  it('reads covered scans from same-origin tiles instead of Overpass', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith('osm/index.json')) return json(index);
      if (url.endsWith('osm/tiles/51_-161.json')) {
        return json([
          [1, 25.76, -80.19, { man_made: 'surveillance', 'camera:direction': 'NE' }],
          [2, 25.95, -80.12, { man_made: 'surveillance' }] // same tile, outside the viewport
        ]);
      }
      throw new Error(`unexpected request ${url}`);
    }));

    const progress: Array<[number, number]> = [];
    const result = await osmProvider.scan({
      mode: 'static', bounds: miami, zoom: 13, staticApiBase: 'https://raven.test/a/api/v1/',
      onProgress: (_features, state) => progress.push([state.completed, state.total])
    }, new AbortController().signal);

    expect(requested).toEqual(['https://raven.test/a/api/v1/osm/index.json', 'https://raven.test/a/api/v1/osm/tiles/51_-161.json']);
    expect(result.features.map(feature => feature.sourceId)).toEqual(['1']);
    expect(result.features[0].bearing).toBe(45);
    expect(result.features[0].attribution).toBe('© OpenStreetMap contributors · Geofabrik north-america/us/florida, data as of 2026-09-22');
    expect(progress).toEqual([[1, 1]]);
    expect(result.warning).toBeUndefined();
  });

  it('falls back to Overpass for scans outside the extract, fetching the index only once', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith('osm/index.json')) return json(index);
      return json({ elements: [] });
    }));
    const newYork = { west: -74.05, south: 40.68, east: -73.9, north: 40.8 };
    for (let scan = 0; scan < 2; scan += 1) {
      await osmProvider.scan({ mode: 'static', bounds: newYork, zoom: 13, staticApiBase: 'https://raven.test/b/api/v1/' }, new AbortController().signal);
    }
    expect(requested.filter(url => url.endsWith('osm/index.json'))).toHaveLength(1);
    expect(requested.filter(url => url.includes('overpass-api.de'))).toHaveLength(2);
  });

  it('uses Overpass when no tiles are published', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      return url.endsWith('osm/index.json') ? new Response('not found', { status: 404 }) : json({ elements: [] });
    }));
    await osmProvider.scan({ mode: 'static', bounds: miami, zoom: 13, staticApiBase: 'https://raven.test/c/api/v1/' }, new AbortController().signal);
    expect(requested.some(url => url.includes('overpass-api.de'))).toBe(true);
  });
});

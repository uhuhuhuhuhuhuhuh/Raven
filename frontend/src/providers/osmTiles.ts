import type { ProviderProgress, RavenBounds } from '../types';

/**
 * Static OpenStreetMap camera tiles published under api/v1/osm/ by
 * scripts/build_osm_tiles.py from a Geofabrik extract. When a scan lies wholly inside
 * the extract's boundary, the OSM provider reads these same-origin files instead of
 * querying the shared public Overpass service.
 */
export type OsmTileIndex = {
  version: 1;
  source: string;
  license: string;
  dataTimestamp: string | null;
  tileSize: number;
  count: number;
  tiles: string[];
  coverage: Array<{ hole: boolean; points: Array<[number, number]> }>;
};

export type OsmElement = { type: 'node'; id: number; lat: number; lon: number; tags: Record<string, string> };

const TILE_CONCURRENCY = 6;

export function parseTileIndex(value: unknown): OsmTileIndex | null {
  const index = value as Partial<OsmTileIndex> | null;
  if (!index || index.version !== 1 || !(Number(index.tileSize) > 0)) return null;
  if (!Array.isArray(index.tiles) || !Array.isArray(index.coverage) || index.coverage.length === 0) return null;
  return index as OsmTileIndex;
}

function inRing(lon: number, lat: number, points: Array<[number, number]>): boolean {
  let inside = false;
  let [previousLon, previousLat] = points[points.length - 1];
  for (const [currentLon, currentLat] of points) {
    if ((currentLat > lat) !== (previousLat > lat)) {
      const crossing = previousLon + ((lat - previousLat) * (currentLon - previousLon)) / (currentLat - previousLat);
      if (lon < crossing) inside = !inside;
    }
    previousLon = currentLon;
    previousLat = currentLat;
  }
  return inside;
}

/** Inside an outer ring and not a hole; lon ± 360 also matches rings drawn past the antimeridian. */
export function coverageContains(coverage: OsmTileIndex['coverage'], lon: number, lat: number): boolean {
  return [lon, lon + 360, lon - 360].some(candidate =>
    coverage.reduce((depth, ring) => depth + (inRing(candidate, lat, ring.points) ? (ring.hole ? -1 : 1) : 0), 0) > 0
  );
}

/** Liang–Barsky clipping: does the segment reach into (or onto) the box at all? */
function segmentTouchesBox(x0: number, y0: number, x1: number, y1: number, box: RavenBounds): boolean {
  let enter = 0;
  let exit = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const edges: Array<[number, number]> = [[-dx, x0 - box.west], [dx, box.east - x0], [-dy, y0 - box.south], [dy, box.north - y0]];
  for (const [direction, distance] of edges) {
    if (direction === 0) {
      if (distance < 0) return false;
      continue;
    }
    const t = distance / direction;
    if (direction < 0) {
      if (t > exit) return false;
      enter = Math.max(enter, t);
    } else {
      if (t < enter) return false;
      exit = Math.min(exit, t);
    }
  }
  return true;
}

/**
 * Whole scan box inside the coverage: every corner is inside and no boundary segment
 * (outer edge or hole) enters the box, so notches and holes within it are caught.
 */
export function boundsCovered(coverage: OsmTileIndex['coverage'], bounds: RavenBounds): boolean {
  const corners: Array<[number, number]> = [[bounds.west, bounds.south], [bounds.east, bounds.south], [bounds.east, bounds.north], [bounds.west, bounds.north]];
  if (!corners.every(([lon, lat]) => coverageContains(coverage, lon, lat))) return false;
  const boxes = [0, 360, -360].map(shift => ({ ...bounds, west: bounds.west + shift, east: bounds.east + shift }));
  for (const ring of coverage) {
    for (let index = 0; index < ring.points.length; index += 1) {
      const [x0, y0] = ring.points[index];
      const [x1, y1] = ring.points[(index + 1) % ring.points.length];
      if (boxes.some(box => segmentTouchesBox(x0, y0, x1, y1, box))) return false;
    }
  }
  return true;
}

/** Keys (`<latIndex>_<lonIndex>`) of every tile the bounds touch. */
export function tileKeysFor(bounds: RavenBounds, tileSize: number): string[] {
  const keys: string[] = [];
  for (let row = Math.floor(bounds.south / tileSize); row <= Math.floor(bounds.north / tileSize); row += 1) {
    for (let column = Math.floor(bounds.west / tileSize); column <= Math.floor(bounds.east / tileSize); column += 1) {
      keys.push(`${row}_${column}`);
    }
  }
  return keys;
}

const indexRequests = new Map<string, Promise<OsmTileIndex | null>>();

/**
 * The tile index under `apiBase`, fetched once per page. A missing or malformed index
 * (no tiles were published) resolves to null; a network failure is retried next scan.
 */
export function loadTileIndex(apiBase: string): Promise<OsmTileIndex | null> {
  let request = indexRequests.get(apiBase);
  if (!request) {
    request = fetch(new URL('osm/index.json', apiBase), { headers: { Accept: 'application/json' } })
      .then(async response => (response.ok ? parseTileIndex(await response.json().catch(() => null)) : null))
      .catch(error => {
        indexRequests.delete(apiBase);
        throw error;
      });
    indexRequests.set(apiBase, request);
  }
  return request.catch(() => null);
}

/**
 * Fetches the published tiles touching `bounds` (a few at a time) and reports the
 * camera nodes inside `bounds` after each tile. Failed tiles are counted, not thrown,
 * unless every tile fails.
 */
export async function loadTileElements(
  index: OsmTileIndex,
  apiBase: string,
  bounds: RavenBounds,
  signal: AbortSignal,
  onTile: (elements: OsmElement[], progress: ProviderProgress) => void
): Promise<{ tiles: number; failed: number; firstError?: unknown }> {
  const published = new Set(index.tiles);
  const keys = tileKeysFor(bounds, index.tileSize).filter(key => published.has(key));
  let next = 0;
  let completed = 0;
  let failed = 0;
  let firstError: unknown;

  async function worker() {
    while (next < keys.length) {
      const key = keys[next];
      next += 1;
      let elements: OsmElement[] = [];
      try {
        const response = await fetch(new URL(`osm/tiles/${key}.json`, apiBase), { signal, headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`OSM tile ${key} failed (${response.status})`);
        const records = (await response.json()) as Array<[number, number, number, Record<string, string>]>;
        elements = records
          .filter(([, lat, lon]) => lat >= bounds.south && lat <= bounds.north && lon >= bounds.west && lon <= bounds.east)
          .map(([id, lat, lon, tags]) => ({ type: 'node', id, lat, lon, tags }));
      } catch (error) {
        if (signal.aborted) throw error;
        failed += 1;
        firstError ??= error;
      }
      completed += 1;
      onTile(elements, { completed, total: keys.length });
    }
  }

  await Promise.all(Array.from({ length: Math.min(TILE_CONCURRENCY, keys.length) }, worker));
  if (keys.length > 0 && failed === keys.length) throw firstError;
  return { tiles: keys.length, failed, firstError };
}

export type OsmChanges = {
  since: string | null;
  until: string | null;
  addedCount: number;
  removedCount: number;
  added: Array<[number, number, number, Record<string, string>]>;
  feed?: string;
};

/** changes.json from the weekly extract build; null for a baseline, a missing file or an unknown shape. */
export async function loadOsmChanges(apiBase: string): Promise<OsmChanges | null> {
  try {
    const response = await fetch(new URL('osm/changes.json', apiBase), { headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    const changes = (await response.json()) as Partial<OsmChanges> & { version?: number; baseline?: boolean };
    if (changes?.version !== 1 || changes.baseline || !Array.isArray(changes.added)) return null;
    return changes as OsmChanges;
  } catch {
    return null;
  }
}

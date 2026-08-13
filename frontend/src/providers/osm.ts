import type { RavenBounds, RavenFeature } from '../types';
import type { RavenProvider } from './types';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const MAX_TILE_SPAN = 0.75;
const MAX_TILES = 24;

function cameraType(tags: Record<string, string>): RavenFeature['cameraType'] {
  if ((tags['surveillance:type'] || '').toLowerCase() === 'alpr') return 'alpr';
  if (tags.highway === 'speed_camera') return 'speed';
  const type = (tags['camera:type'] || '').toLowerCase();
  if (type === 'fixed') return 'fixed';
  if (type === 'dome') return 'dome';
  if (type === 'panning') return 'ptz';
  if (type.startsWith('panorama')) return 'panorama';
  return 'unknown';
}

function parseBearing(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.replace('°', '').trim());
  return Number.isFinite(parsed) ? ((parsed % 360) + 360) % 360 : undefined;
}

function normalizeElement(element: any): RavenFeature | null {
  if (typeof element?.lat !== 'number' || typeof element?.lon !== 'number') return null;
  const tags = (element.tags || {}) as Record<string, string>;
  const address = [tags['addr:housenumber'], tags['addr:street'], tags['addr:city']].filter(Boolean).join(' ') || undefined;
  return {
    id: `osm-${element.type}-${element.id}`,
    providerId: 'osm-overpass',
    sourceId: String(element.id),
    kind: 'camera',
    cameraType: cameraType(tags),
    mediaType: 'none',
    mediaHealth: 'unknown',
    name: tags.name || tags.ref || tags.operator || 'Mapped camera',
    lat: element.lat,
    lon: element.lon,
    address,
    bearing: parseBearing(tags.direction),
    directionLabel: tags.direction,
    operator: tags.operator,
    zone: tags['surveillance:zone'],
    sourceUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,
    attribution: '© OpenStreetMap contributors',
    fetchedAt: new Date().toISOString(),
    metadata: tags
  };
}

export function tileBounds(bounds: RavenBounds): RavenBounds[] {
  const width = Math.max(0.0001, bounds.east - bounds.west);
  const height = Math.max(0.0001, bounds.north - bounds.south);
  let columns = Math.max(1, Math.ceil(width / MAX_TILE_SPAN));
  let rows = Math.max(1, Math.ceil(height / MAX_TILE_SPAN));

  if (columns * rows > MAX_TILES) {
    const scale = Math.sqrt(MAX_TILES / (columns * rows));
    columns = Math.max(1, Math.floor(columns * scale));
    rows = Math.max(1, Math.floor(rows * scale));
    while (columns * rows > MAX_TILES) {
      if (columns >= rows && columns > 1) columns -= 1;
      else if (rows > 1) rows -= 1;
      else break;
    }
  }

  const stepX = width / columns;
  const stepY = height / rows;
  const tiles: RavenBounds[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      tiles.push({
        west: bounds.west + column * stepX,
        south: bounds.south + row * stepY,
        east: column === columns - 1 ? bounds.east : bounds.west + (column + 1) * stepX,
        north: row === rows - 1 ? bounds.north : bounds.south + (row + 1) * stepY
      });
    }
  }
  return tiles;
}

async function scanTile(mode: 'static' | 'local', bounds: RavenBounds, signal: AbortSignal): Promise<RavenFeature[]> {
  const { west, south, east, north } = bounds;
  if (mode === 'local') {
    const query = new URLSearchParams({ west: String(west), south: String(south), east: String(east), north: String(north) });
    const response = await fetch(`/api/scan?${query.toString()}`, { signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Local OSM scan failed (${response.status})`);
    const payload = await response.json();
    return (payload.features || []) as RavenFeature[];
  }

  const bbox = `${south},${west},${north},${east}`;
  const overpassQuery = `[out:json][timeout:25];(node["man_made"="surveillance"](${bbox});node["highway"="speed_camera"](${bbox}););out body;`;
  const body = new URLSearchParams({ data: overpassQuery });
  const response = await fetch(OVERPASS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body,
    signal
  });
  if (!response.ok) throw new Error(`OpenStreetMap scan failed (${response.status})`);
  const payload = await response.json();
  return (payload.elements || []).map(normalizeElement).filter(Boolean) as RavenFeature[];
}

export const osmProvider: RavenProvider = {
  id: 'osm-overpass',
  name: 'OpenStreetMap / Overpass',
  attribution: '© OpenStreetMap contributors',
  capabilities: ['mapped-camera', 'camera-type', 'direction', 'operator'],
  minZoom: 8,
  cacheTtlMs: 5 * 60 * 1000,
  async scan(request, signal) {
    const tiles = tileBounds(request.bounds);
    const deduped = new Map<string, RavenFeature>();
    let completed = 0;

    for (const tile of tiles) {
      if (signal.aborted) throw new DOMException('Scan aborted', 'AbortError');
      const features = await scanTile(request.mode === 'local' ? 'local' : 'static', tile, signal);
      for (const feature of features) deduped.set(feature.id, feature);
      completed += 1;
      request.onProgress?.(Array.from(deduped.values()), { completed, total: tiles.length });
    }

    return { features: Array.from(deduped.values()), pages: tiles.length };
  }
};

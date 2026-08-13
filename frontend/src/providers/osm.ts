import type { RavenFeature } from '../types';
import type { RavenProvider } from './types';

const OVERPASS = 'https://overpass-api.de/api/interpreter';

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

export const osmProvider: RavenProvider = {
  id: 'osm-overpass',
  name: 'OpenStreetMap / Overpass',
  attribution: '© OpenStreetMap contributors',
  capabilities: ['mapped-camera', 'camera-type', 'direction', 'operator'],
  async scan(request, signal) {
    const { west, south, east, north } = request.bounds;
    if (request.mode === 'local') {
      const query = new URLSearchParams({
        west: String(west),
        south: String(south),
        east: String(east),
        north: String(north)
      });
      const response = await fetch(`/api/scan?${query.toString()}`, { signal, headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Local OSM scan failed (${response.status})`);
      const payload = await response.json();
      return { features: (payload.features || []) as RavenFeature[], pages: 1 };
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
    const features = (payload.elements || []).map(normalizeElement).filter(Boolean) as RavenFeature[];
    return { features, pages: 1 };
  }
};

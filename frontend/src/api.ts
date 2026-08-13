import type { RavenFeature, RavenMode } from './types';

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
    name: tags.name || tags.ref || tags.operator || 'Mapped camera',
    lat: element.lat,
    lon: element.lon,
    address,
    bearing: parseBearing(tags.direction),
    operator: tags.operator,
    zone: tags['surveillance:zone'],
    sourceUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,
    attribution: '© OpenStreetMap contributors',
    fetchedAt: new Date().toISOString(),
    metadata: tags
  };
}

export async function detectMode(): Promise<RavenMode> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 1100);
  try {
    const response = await fetch(`${window.location.origin}/api/health`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) return 'static';
    const payload = await response.json();
    return payload?.service === 'raven' ? 'local' : 'static';
  } catch {
    return 'static';
  } finally {
    clearTimeout(timer);
  }
}

export async function scanArea(mode: RavenMode, lat: number, lon: number, radius: number): Promise<RavenFeature[]> {
  if (mode === 'local') {
    const query = new URLSearchParams({ lat: String(lat), lon: String(lon), radius: String(radius) });
    const response = await fetch(`/api/scan?${query}`);
    if (!response.ok) throw new Error(`Local scan failed (${response.status})`);
    const payload = await response.json();
    return payload.features as RavenFeature[];
  }

  const overpassQuery = `[out:json][timeout:25];(node["man_made"="surveillance"](around:${Math.round(radius)},${lat},${lon});node["highway"="speed_camera"](around:${Math.round(radius)},${lat},${lon}););out body;`;
  const body = new URLSearchParams({ data: overpassQuery });
  const response = await fetch(OVERPASS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body
  });
  if (!response.ok) throw new Error(`OpenStreetMap scan failed (${response.status})`);
  const payload = await response.json();
  return (payload.elements || []).map(normalizeElement).filter(Boolean) as RavenFeature[];
}

export async function searchPlace(query: string): Promise<{ lat: number; lon: number; label: string } | null> {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Search failed (${response.status})`);
  const results = await response.json();
  if (!results?.length) return null;
  return { lat: Number(results[0].lat), lon: Number(results[0].lon), label: results[0].display_name };
}

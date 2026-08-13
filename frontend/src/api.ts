import type { RavenFeature, RavenMode } from './types';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const FL511_CAMERAS = 'https://services.arcgis.com/3wFbqsFPLeKqOlIK/arcgis/rest/services/FL511_Traffic_Cameras/FeatureServer/0/query';

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

function publicHttpsUrl(value?: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith('https://')) return trimmed;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  return undefined;
}

function normalizeFl511Feature(feature: any): RavenFeature | null {
  const attributes = feature?.attributes || {};
  const lon = Number(feature?.geometry?.x ?? attributes.LONGITUDE);
  const lat = Number(feature?.geometry?.y ?? attributes.LATITUDE);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const id = String(attributes.ID ?? attributes.OBJECTID_1 ?? `${lat}-${lon}`);
  const snapshotUrl = publicHttpsUrl(attributes.IMAGE);
  const direction = typeof attributes.DIRECTION === 'string' ? attributes.DIRECTION.trim() : undefined;

  return {
    id: `fl511-${id}`,
    providerId: 'fl511-public-cameras',
    sourceId: id,
    kind: 'live-feed',
    cameraType: 'fixed',
    name: attributes.DESCRIPT || attributes.HIGHWAY || `FL511 Camera ${id}`,
    lat,
    lon,
    bearing: parseBearing(direction),
    operator: 'FL511 / Florida DOT',
    zone: attributes.COUNTY,
    sourceUrl: snapshotUrl || 'https://fl511.com/',
    snapshotUrl,
    feedUrl: snapshotUrl,
    sourceUpdatedAt: attributes.TIMESTAMP ? String(attributes.TIMESTAMP) : undefined,
    status: snapshotUrl ? 'PUBLIC SNAPSHOT' : 'PUBLIC CAMERA',
    attribution: 'FL511 public traffic camera data',
    fetchedAt: new Date().toISOString(),
    metadata: attributes
  };
}

function distanceMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = (value: number) => value * Math.PI / 180;
  const earth = 6371000;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earth * Math.asin(Math.sqrt(h));
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

async function scanMappedCameras(mode: RavenMode, lat: number, lon: number, radius: number): Promise<RavenFeature[]> {
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

async function scanFl511Cameras(lat: number, lon: number, radius: number): Promise<RavenFeature[]> {
  const latDelta = radius / 111320;
  const cosLat = Math.max(Math.cos(lat * Math.PI / 180), 0.2);
  const lonDelta = radius / (111320 * cosLat);
  const envelope = [lon - lonDelta, lat - latDelta, lon + lonDelta, lat + latDelta].join(',');

  const query = new URLSearchParams({
    where: '1=1',
    geometry: envelope,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'OBJECTID_1,ID,DESCRIPT,COUNTY,HIGHWAY,DIRECTION,LATITUDE,LONGITUDE,TIMESTAMP,IMAGE',
    returnGeometry: 'true',
    outSR: '4326',
    resultRecordCount: '2000',
    f: 'json'
  });

  const response = await fetch(`${FL511_CAMERAS}?${query.toString()}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`FL511 camera query failed (${response.status})`);
  const payload = await response.json();
  if (payload?.error) throw new Error(payload.error.message || 'FL511 camera query failed');

  return (payload.features || [])
    .map(normalizeFl511Feature)
    .filter((feature: RavenFeature | null): feature is RavenFeature => Boolean(feature))
    .filter((feature: RavenFeature) => distanceMeters(lat, lon, feature.lat, feature.lon) <= radius);
}

export async function scanArea(mode: RavenMode, lat: number, lon: number, radius: number, includeLive = true): Promise<RavenFeature[]> {
  const requests: Promise<RavenFeature[]>[] = [scanMappedCameras(mode, lat, lon, radius)];
  if (includeLive) requests.push(scanFl511Cameras(lat, lon, radius));

  const settled = await Promise.allSettled(requests);
  const successful = settled.filter((result): result is PromiseFulfilledResult<RavenFeature[]> => result.status === 'fulfilled');
  if (successful.length === 0) {
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    throw failed?.reason instanceof Error ? failed.reason : new Error('All public camera providers failed');
  }

  const merged = successful.flatMap(result => result.value);
  const deduped = new Map<string, RavenFeature>();
  merged.forEach(feature => deduped.set(feature.id, feature));
  return Array.from(deduped.values());
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

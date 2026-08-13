import type { RavenFeature } from '../types';
import { clipBounds, type RavenProvider } from './types';

const FL511_CAMERAS = 'https://services.arcgis.com/3wFbqsFPLeKqOlIK/arcgis/rest/services/FL511_Traffic_Cameras/FeatureServer/0/query';
const FLORIDA_BOUNDS = { west: -87.7, south: 24.3, east: -79.7, north: 31.2 };
const PAGE_SIZE = 2000;
const MAX_PAGES = 20;

function publicHttpsUrl(value?: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith('https://')) return trimmed;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  return undefined;
}

function parseBearing(value?: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = Number(String(value).replace('°', '').trim());
  return Number.isFinite(parsed) ? ((parsed % 360) + 360) % 360 : undefined;
}

function normalizeFeature(feature: any): RavenFeature | null {
  const attributes = feature?.attributes || {};
  const lon = Number(feature?.geometry?.x ?? attributes.LONGITUDE);
  const lat = Number(feature?.geometry?.y ?? attributes.LATITUDE);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const id = String(attributes.ID ?? attributes.OBJECTID_1 ?? `${lat}-${lon}`);
  const snapshotUrl = publicHttpsUrl(attributes.IMAGE);
  const directionLabel = typeof attributes.DIRECTION === 'string' ? attributes.DIRECTION.trim() || undefined : undefined;

  return {
    id: `fl511-${id}`,
    providerId: 'fl511-public-cameras',
    sourceId: id,
    kind: 'camera',
    cameraType: 'fixed',
    mediaType: snapshotUrl ? 'snapshot' : 'external',
    mediaHealth: snapshotUrl ? 'active' : 'unknown',
    name: attributes.DESCRIPT || attributes.HIGHWAY || `FL511 Camera ${id}`,
    lat,
    lon,
    bearing: parseBearing(attributes.DIRECTION),
    directionLabel,
    operator: 'FL511 / Florida DOT',
    zone: attributes.COUNTY,
    sourceUrl: 'https://fl511.com/cctv',
    snapshotUrl,
    sourceUpdatedAt: attributes.TIMESTAMP ? String(attributes.TIMESTAMP) : undefined,
    attribution: 'FL511 / Florida Department of Transportation',
    fetchedAt: new Date().toISOString(),
    metadata: attributes
  };
}

async function requestPage(envelope: string, offset: number, signal: AbortSignal) {
  const query = new URLSearchParams({
    where: '1=1',
    geometry: envelope,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'OBJECTID_1,ID,DESCRIPT,COUNTY,HIGHWAY,DIRECTION,LATITUDE,LONGITUDE,TIMESTAMP,IMAGE',
    returnGeometry: 'true',
    outSR: '4326',
    orderByFields: 'OBJECTID_1 ASC',
    resultOffset: String(offset),
    resultRecordCount: String(PAGE_SIZE),
    f: 'json'
  });
  const response = await fetch(`${FL511_CAMERAS}?${query.toString()}`, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`FL511 query failed (${response.status})`);
  const payload = await response.json();
  if (payload?.error) throw new Error(payload.error.message || 'FL511 query failed');
  return payload;
}

export const fl511Provider: RavenProvider = {
  id: 'fl511-public-cameras',
  name: 'FL511 Traffic Cameras',
  attribution: 'FL511 / Florida Department of Transportation',
  capabilities: ['snapshot', 'direction', 'operator'],
  coverage: FLORIDA_BOUNDS,
  minZoom: 6,
  cacheTtlMs: 60 * 1000,
  async scan(request, signal) {
    const clipped = clipBounds(request.bounds, FLORIDA_BOUNDS);
    if (!clipped) return { features: [], pages: 0 };
    const { west, south, east, north } = clipped;
    const envelope = [west, south, east, north].join(',');
    const deduped = new Map<string, RavenFeature>();
    let pages = 0;

    for (let offset = 0; pages < MAX_PAGES; offset += PAGE_SIZE) {
      if (signal.aborted) throw new DOMException('Scan aborted', 'AbortError');
      const payload = await requestPage(envelope, offset, signal);
      pages += 1;
      const normalized = (payload.features || [])
        .map(normalizeFeature)
        .filter((feature: RavenFeature | null): feature is RavenFeature => Boolean(feature));
      for (const feature of normalized) deduped.set(feature.id, feature);
      const more = Boolean(payload.exceededTransferLimit) || (payload.features || []).length >= PAGE_SIZE;
      request.onProgress?.(Array.from(deduped.values()), { completed: pages, total: more ? pages + 1 : pages });
      if (!more || (payload.features || []).length === 0) break;
    }

    return { features: Array.from(deduped.values()), pages };
  }
};

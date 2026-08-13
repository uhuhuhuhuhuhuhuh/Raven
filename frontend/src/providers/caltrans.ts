import type { RavenFeature } from '../types';
import { clipBounds, type RavenProvider } from './types';

const CALTRANS_CCTV = 'https://caltrans-gis.dot.ca.gov/arcgis/rest/services/CHhighway/CCTV/FeatureServer/0/query';
const CALIFORNIA_BOUNDS = { west: -124.6, south: 32.3, east: -114.0, north: 42.2 };
const PAGE_SIZE = 2000;
const MAX_PAGES = 20;

function publicHttpsUrl(value?: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith('https://')) return trimmed;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  return undefined;
}

function directVideoUrl(value?: string): string | undefined {
  if (!value) return undefined;
  return /\.(?:mp4|webm|ogg|ogv)(?:[?#].*)?$/i.test(value) ? value : undefined;
}

function recordTimestamp(attributes: Record<string, any>): string | undefined {
  const epoch = Number(attributes.recordEpoch);
  if (Number.isFinite(epoch) && epoch > 0) return new Date(epoch * 1000).toISOString();
  const date = typeof attributes.recordDate === 'string' ? attributes.recordDate.trim() : '';
  const time = typeof attributes.recordTime === 'string' ? attributes.recordTime.trim() : '';
  return date ? `${date}${time ? ` ${time}` : ''}` : undefined;
}

function normalizeFeature(feature: any): RavenFeature | null {
  const attributes = (feature?.attributes || {}) as Record<string, any>;
  const lon = Number(feature?.geometry?.x ?? attributes.longitude);
  const lat = Number(feature?.geometry?.y ?? attributes.latitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const id = String(attributes.OBJECTID ?? attributes.index_ ?? `${lat}-${lon}`);
  const snapshotUrl = publicHttpsUrl(attributes.currentImageURL);
  const publishedStream = publicHttpsUrl(attributes.streamingVideoURL);
  const streamUrl = directVideoUrl(publishedStream);
  const streamPageUrl = publishedStream && !streamUrl ? publishedStream : undefined;
  const hasStream = Boolean(streamUrl || streamPageUrl);
  const inService = String(attributes.inService || '').trim().toLowerCase();

  return {
    id: `caltrans-${id}`,
    providerId: 'caltrans-cctv',
    sourceId: id,
    kind: 'camera',
    cameraType: 'fixed',
    mediaType: hasStream ? 'stream' : snapshotUrl ? 'snapshot' : 'external',
    mediaHealth: inService === 'false' || inService === 'no' ? 'offline' : snapshotUrl || hasStream ? 'active' : 'unknown',
    name: attributes.locationName || attributes.imageDescription || `${attributes.route || 'Caltrans'} Camera ${id}`,
    lat,
    lon,
    directionLabel: typeof attributes.direction === 'string' ? attributes.direction.trim() || undefined : undefined,
    operator: 'Caltrans',
    zone: attributes.county,
    sourceUrl: streamPageUrl || 'https://quickmap.dot.ca.gov/',
    snapshotUrl,
    streamUrl,
    streamPageUrl,
    sourceUpdatedAt: recordTimestamp(attributes),
    attribution: 'Caltrans / State of California',
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
    outFields: 'OBJECTID,index_,recordDate,recordTime,recordEpoch,district,locationName,nearbyPlace,longitude,latitude,direction,county,route,inService,imageDescription,streamingVideoURL,currentImageUpdateFrequency,currentImageURL',
    returnGeometry: 'true',
    outSR: '4326',
    orderByFields: 'OBJECTID ASC',
    resultOffset: String(offset),
    resultRecordCount: String(PAGE_SIZE),
    f: 'json'
  });
  const response = await fetch(`${CALTRANS_CCTV}?${query.toString()}`, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Caltrans CCTV query failed (${response.status})`);
  const payload = await response.json();
  if (payload?.error) throw new Error(payload.error.message || 'Caltrans CCTV query failed');
  return payload;
}

export const caltransProvider: RavenProvider = {
  id: 'caltrans-cctv',
  name: 'Caltrans CCTV',
  attribution: 'Caltrans / State of California',
  capabilities: ['snapshot', 'stream', 'direction', 'operator'],
  coverage: CALIFORNIA_BOUNDS,
  cacheTtlMs: 60 * 1000,
  async scan(request, signal) {
    const clipped = clipBounds(request.bounds, CALIFORNIA_BOUNDS);
    if (!clipped) return { features: [], pages: 0 };
    const envelope = [clipped.west, clipped.south, clipped.east, clipped.north].join(',');
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

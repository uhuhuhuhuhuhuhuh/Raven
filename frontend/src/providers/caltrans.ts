import type { RavenFeature } from '../types';
import { queryArcGisEnvelope, type ArcGisLayer } from './arcgis';
import { publicHttpsUrl } from './normalize';
import { clipBounds, type RavenProvider } from './types';

const CALTRANS_CCTV = 'https://caltrans-gis.dot.ca.gov/arcgis/rest/services/CHhighway/CCTV/FeatureServer/0/query';
const CALIFORNIA_BOUNDS = { west: -124.6, south: 32.3, east: -114.0, north: 42.2 };

/** A media resource the browser can play in-app: progressive video or an HLS playlist. */
function directVideoUrl(value?: string): string | undefined {
  if (!value) return undefined;
  return /\.(?:mp4|webm|ogg|ogv|m3u8)(?:[?#].*)?$/i.test(value) ? value : undefined;
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

const CALTRANS_LAYER: ArcGisLayer = {
  url: CALTRANS_CCTV,
  label: 'Caltrans CCTV',
  outFields: [
    'OBJECTID', 'index_', 'recordDate', 'recordTime', 'recordEpoch', 'district', 'locationName', 'nearbyPlace',
    'longitude', 'latitude', 'direction', 'county', 'route', 'inService', 'imageDescription', 'streamingVideoURL',
    'currentImageUpdateFrequency', 'currentImageURL'
  ],
  orderByField: 'OBJECTID',
  normalize: normalizeFeature
};

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
    return queryArcGisEnvelope(CALTRANS_LAYER, clipped, signal, request.onProgress);
  }
};

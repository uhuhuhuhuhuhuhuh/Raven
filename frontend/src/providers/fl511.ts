import type { RavenFeature } from '../types';
import { queryArcGisEnvelope, type ArcGisLayer } from './arcgis';
import { parseBearing, publicHttpsUrl } from './normalize';
import { clipBounds, type RavenProvider } from './types';

const FL511_CAMERAS = 'https://services.arcgis.com/3wFbqsFPLeKqOlIK/arcgis/rest/services/FL511_Traffic_Cameras/FeatureServer/0/query';
const FLORIDA_BOUNDS = { west: -87.7, south: 24.3, east: -79.7, north: 31.2 };

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

const FL511_LAYER: ArcGisLayer = {
  url: FL511_CAMERAS,
  label: 'FL511',
  outFields: ['OBJECTID_1', 'ID', 'DESCRIPT', 'COUNTY', 'HIGHWAY', 'DIRECTION', 'LATITUDE', 'LONGITUDE', 'TIMESTAMP', 'IMAGE'],
  orderByField: 'OBJECTID_1',
  normalize: normalizeFeature
};

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
    return queryArcGisEnvelope(FL511_LAYER, clipped, signal, request.onProgress);
  }
};

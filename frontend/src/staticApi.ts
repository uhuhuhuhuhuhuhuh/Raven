import { isHlsUrl } from './providers/normalize';
import type { RavenFeature } from './types';

/**
 * Raven's static JSON API: files generated at deploy time and served by GitHub Pages
 * (which sends Access-Control-Allow-Origin: *) or by Raven Local under /api/v1.
 */
export const API_VERSION = 1;

export type ApiStream = { url: string; format: 'hls' | 'progressive' };

export type ApiCamera = {
  id: string;
  provider: string;
  name: string;
  lat: number;
  lon: number;
  direction?: string;
  zone?: string;
  operator?: string;
  health?: string;
  snapshotUrl?: string;
  stream?: ApiStream;
  streamPageUrl?: string;
  sourceUrl?: string;
  sourceUpdatedAt?: string;
  attribution?: string;
};

export type ProviderCatalogResult = {
  id: string;
  name: string;
  attribution: string;
  features?: RavenFeature[];
  warning?: string;
  error?: string;
};

export function toApiCamera(feature: RavenFeature): ApiCamera {
  return {
    id: feature.id,
    provider: feature.providerId,
    name: feature.name || feature.id,
    lat: Number(feature.lat.toFixed(6)),
    lon: Number(feature.lon.toFixed(6)),
    direction: feature.directionLabel,
    zone: feature.zone,
    operator: feature.operator,
    health: feature.mediaHealth,
    snapshotUrl: feature.snapshotUrl,
    stream: feature.streamUrl ? { url: feature.streamUrl, format: isHlsUrl(feature.streamUrl) ? 'hls' : 'progressive' } : undefined,
    streamPageUrl: feature.streamPageUrl,
    sourceUrl: feature.sourceUrl,
    sourceUpdatedAt: feature.sourceUpdatedAt,
    attribution: feature.attribution
  };
}

/** GeoJSON FeatureCollection of API records, for GIS tools such as QGIS or uMap. */
export function camerasGeoJson(cameras: ApiCamera[], generatedAt: string) {
  return {
    type: 'FeatureCollection' as const,
    generatedAt,
    features: cameras.map(({ lat, lon, id, ...properties }) => ({
      type: 'Feature' as const,
      id,
      geometry: { type: 'Point' as const, coordinates: [lon, lat] },
      properties: { id, ...properties }
    }))
  };
}

/** Maps output file names (relative to api/v1/) to their JSON documents. */
export function buildStaticApi(results: ProviderCatalogResult[], generatedAt: string, extraEndpoints: Record<string, string> = {}) {
  const cameras = results
    .flatMap(result => (result.features || []).map(toApiCamera))
    .sort((a, b) => a.id.localeCompare(b.id));
  const streams = cameras.filter(camera => camera.stream);
  return {
    'index.json': {
      name: 'Raven public camera API',
      version: API_VERSION,
      generatedAt,
      notice: 'Public/open data only. Each record carries its source attribution; media URLs are exactly as the agency publishes them.',
      endpoints: {
        cameras: 'cameras.json',
        streams: 'streams.json',
        camerasGeoJson: 'cameras.geojson',
        streamsGeoJson: 'streams.geojson',
        ...extraEndpoints
      },
      providers: results.map(result => ({
        id: result.id,
        name: result.name,
        attribution: result.attribution,
        status: result.error ? 'error' : result.warning ? 'partial' : 'ok',
        cameras: cameras.filter(camera => camera.provider === result.id).length,
        streams: streams.filter(camera => camera.provider === result.id).length,
        ...(result.warning ? { warning: result.warning } : {}),
        ...(result.error ? { error: result.error } : {})
      }))
    },
    'cameras.json': { version: API_VERSION, generatedAt, count: cameras.length, cameras },
    'streams.json': { version: API_VERSION, generatedAt, count: streams.length, streams },
    'cameras.geojson': camerasGeoJson(cameras, generatedAt),
    'streams.geojson': camerasGeoJson(streams, generatedAt)
  };
}

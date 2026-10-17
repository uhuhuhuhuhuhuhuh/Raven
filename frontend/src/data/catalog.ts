import type { ApiCamera } from '../staticApi';
import type { RavenFeature } from '../types';

/**
 * The live-camera catalog (FL511, Caltrans, …) that the deploy publishes as
 * api/v1/cameras.json. Loaded once per session and filtered by viewport locally, so
 * panning the map costs no agency requests. Raven Local serves the same file.
 */
export type Catalog = { features: RavenFeature[]; generatedAt: string | null; providers: string[] };

export function featureFromApiCamera(camera: ApiCamera, fetchedAt: string): RavenFeature {
  return {
    id: camera.id,
    providerId: camera.provider,
    kind: 'camera',
    cameraType: 'unknown',
    mediaType: camera.stream ? 'stream' : camera.snapshotUrl ? 'snapshot' : camera.streamPageUrl ? 'external' : 'none',
    mediaHealth: (camera.health as RavenFeature['mediaHealth']) ?? 'unknown',
    name: camera.name,
    lat: camera.lat,
    lon: camera.lon,
    directionLabel: camera.direction,
    zone: camera.zone,
    operator: camera.operator,
    snapshotUrl: camera.snapshotUrl,
    streamUrl: camera.stream?.url,
    streamPageUrl: camera.streamPageUrl,
    sourceUrl: camera.sourceUrl,
    sourceUpdatedAt: camera.sourceUpdatedAt,
    attribution: camera.attribution,
    fetchedAt,
    metadata: { ...(camera.stream ? { streamFormat: camera.stream.format, streamOnline: camera.stream.online } : {}) }
  };
}

export function parseCatalog(payload: unknown): Catalog | null {
  const document = payload as { version?: number; generatedAt?: string; cameras?: ApiCamera[] } | null;
  if (!document || document.version !== 1 || !Array.isArray(document.cameras)) return null;
  const fetchedAt = new Date().toISOString();
  const features = document.cameras
    .filter(camera => Number.isFinite(camera?.lat) && Number.isFinite(camera?.lon) && typeof camera.id === 'string')
    .map(camera => featureFromApiCamera(camera, fetchedAt));
  return { features, generatedAt: document.generatedAt ?? null, providers: Array.from(new Set(features.map(feature => feature.providerId))) };
}

/** Null when the catalog is missing (no deploy has published it) or unreadable. */
export async function loadCatalog(apiBase: string, signal?: AbortSignal, fetchImpl: typeof fetch = (...args) => fetch(...args)): Promise<Catalog | null> {
  try {
    const response = await fetchImpl(new URL('cameras.json', apiBase), { signal, headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    return parseCatalog(await response.json());
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

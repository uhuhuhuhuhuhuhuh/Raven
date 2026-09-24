import { abortError, fetchWithRetry } from '../net';
import type { ProviderProgress, RavenBounds, RavenFeature } from '../types';
import type { ProviderScanResult } from './types';

const PAGE_SIZE = 2000;
const MAX_PAGES = 20;

export type ArcGisLayer = {
  /** FeatureServer layer query endpoint. */
  url: string;
  /** Short source name used in error messages. */
  label: string;
  outFields: string[];
  orderByField: string;
  normalize: (record: any) => RavenFeature | null;
};

async function requestPage(layer: ArcGisLayer, envelope: string, offset: number, signal: AbortSignal) {
  const query = new URLSearchParams({
    where: '1=1',
    geometry: envelope,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: layer.outFields.join(','),
    returnGeometry: 'true',
    outSR: '4326',
    orderByFields: `${layer.orderByField} ASC`,
    resultOffset: String(offset),
    resultRecordCount: String(PAGE_SIZE),
    f: 'json'
  });
  const response = await fetchWithRetry(`${layer.url}?${query.toString()}`, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${layer.label} query failed (${response.status})`);
  const payload = await response.json();
  if (payload?.error) throw new Error(payload.error.message || `${layer.label} query failed`);
  return payload;
}

/**
 * Pages through every record intersecting `bounds`, reporting progress per page.
 * A failure after the first page keeps the records already fetched and returns
 * them with a warning instead of discarding them.
 */
export async function queryArcGisEnvelope(
  layer: ArcGisLayer,
  bounds: RavenBounds,
  signal: AbortSignal,
  onProgress?: (features: RavenFeature[], progress: ProviderProgress) => void
): Promise<ProviderScanResult> {
  const envelope = [bounds.west, bounds.south, bounds.east, bounds.north].join(',');
  const deduped = new Map<string, RavenFeature>();
  let pages = 0;
  let more = true;

  while (more && pages < MAX_PAGES) {
    if (signal.aborted) throw new DOMException('Scan aborted', 'AbortError');
    let payload;
    try {
      payload = await requestPage(layer, envelope, pages * PAGE_SIZE, signal);
    } catch (error) {
      if (pages === 0 || signal.aborted || abortError(error)) throw error;
      const message = error instanceof Error ? error.message : `${layer.label} query failed`;
      return { features: Array.from(deduped.values()), pages, warning: `PAGE ${pages + 1} FAILED · RESULTS INCOMPLETE · ${message}` };
    }
    pages += 1;
    const records: unknown[] = payload.features || [];
    for (const record of records) {
      const feature = layer.normalize(record);
      if (feature) deduped.set(feature.id, feature);
    }
    more = records.length > 0 && (Boolean(payload.exceededTransferLimit) || records.length >= PAGE_SIZE);
    onProgress?.(Array.from(deduped.values()), { completed: pages, total: more ? pages + 1 : pages });
  }

  return {
    features: Array.from(deduped.values()),
    pages,
    warning: more ? `RESULT LIMIT REACHED AFTER ${pages} PAGES · ZOOM IN FOR COMPLETE DATA` : undefined
  };
}

import type { RavenFeature } from './types';

/**
 * GeoJSON for the cameras currently shown. The collection lists every source's
 * attribution: OpenStreetMap-derived data must stay credited under the ODbL.
 */
export function featuresToGeoJson(features: RavenFeature[], generatedAt: string) {
  return {
    type: 'FeatureCollection' as const,
    generator: 'Raven',
    generatedAt,
    attribution: Array.from(new Set(features.map(feature => feature.attribution).filter((value): value is string => Boolean(value)))).sort(),
    features: features.map(feature => ({
      type: 'Feature' as const,
      id: feature.id,
      geometry: { type: 'Point' as const, coordinates: [feature.lon, feature.lat] },
      properties: {
        provider: feature.providerId,
        name: feature.name,
        cameraType: feature.cameraType,
        mediaType: feature.mediaType,
        bearing: feature.bearing,
        direction: feature.directionLabel,
        operator: feature.operator,
        manufacturer: feature.manufacturer,
        snapshotUrl: feature.snapshotUrl,
        streamUrl: feature.streamUrl,
        streamPageUrl: feature.streamPageUrl,
        sourceUrl: feature.sourceUrl,
        attribution: feature.attribution
      }
    }))
  };
}

export function downloadGeoJson(filename: string, collection: ReturnType<typeof featuresToGeoJson>) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(collection)], { type: 'application/geo+json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // Revoke after the click has been handled so the download is not cancelled.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

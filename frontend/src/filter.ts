import { MARKER_BY_KEY, markerKey, markerTag } from './markers';
import type { RavenFeature } from './types';

/** True when every whitespace-separated term appears in one of the feature's descriptive fields. */
export function matchesFilter(feature: RavenFeature, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [
    feature.name,
    feature.operator,
    feature.zone,
    feature.address,
    feature.directionLabel,
    feature.providerId,
    feature.cameraType,
    MARKER_BY_KEY[markerKey(feature)].label,
    markerTag(feature)
  ].filter(Boolean).join(' ').toLowerCase();
  return terms.every(term => haystack.includes(term));
}

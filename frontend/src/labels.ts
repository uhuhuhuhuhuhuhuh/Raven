import { hasSnapshot, hasStream } from './state';
import type { RavenFeature } from './types';

/** Long-form class shown in the contact detail card. */
export function classLabel(feature: RavenFeature) {
  if (hasStream(feature)) return 'STREAM';
  if (hasSnapshot(feature)) return 'SNAPSHOT';
  if (feature.mediaType === 'external') return 'EXTERNAL';
  return (feature.cameraType || 'unknown').toUpperCase();
}

/** Compact tag shown in Contact Register rows. */
export function shortClassLabel(feature: RavenFeature) {
  const stream = hasStream(feature);
  const snapshot = hasSnapshot(feature);
  if (stream && snapshot) return 'STREAM+SNAP';
  if (stream) return 'STREAM';
  if (snapshot) return 'SNAP';
  if (feature.cameraType === 'speed') return 'SPEED';
  return (feature.cameraType || 'unknown').toUpperCase();
}

export function mediaClass(feature: RavenFeature) {
  if (hasStream(feature)) return 'stream';
  if (hasSnapshot(feature)) return 'snapshot';
  return feature.mediaType;
}

import type { RavenBounds, RavenFeature } from '../types';

export function boundsContain(outer: RavenBounds, inner: RavenBounds): boolean {
  return inner.west >= outer.west && inner.east <= outer.east && inner.south >= outer.south && inner.north <= outer.north;
}

/** The bounds grown by `fraction` of their size on every side (clamped to the globe). */
export function padBounds(bounds: RavenBounds, fraction: number): RavenBounds {
  const dx = (bounds.east - bounds.west) * fraction;
  const dy = (bounds.north - bounds.south) * fraction;
  return {
    west: Math.max(-180, bounds.west - dx),
    east: Math.min(180, bounds.east + dx),
    south: Math.max(-90, bounds.south - dy),
    north: Math.min(90, bounds.north + dy)
  };
}

export function inBounds(feature: Pick<RavenFeature, 'lat' | 'lon'>, bounds: RavenBounds): boolean {
  return feature.lat >= bounds.south && feature.lat <= bounds.north && feature.lon >= bounds.west && feature.lon <= bounds.east;
}

export function filterByBounds<T extends Pick<RavenFeature, 'lat' | 'lon'>>(features: T[], bounds: RavenBounds): T[] {
  return features.filter(feature => inBounds(feature, bounds));
}

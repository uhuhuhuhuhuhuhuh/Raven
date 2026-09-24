import { destinationPoint, formatRange } from './geo';
import type { RavenFeature, RavenPoint } from './types';

/** Illustrative camera coverage: sources publish a facing, not a lens angle or range. */
export const FOV_RADIUS_M = 45;
export const FOV_HALF_ANGLE = 30;
export const RANGE_RING_METERS = [250, 500, 1000, 2000, 5000];

type Position = [number, number];

function position(point: RavenPoint): Position {
  return [point.lon, point.lat];
}

/** Closed polygon ring for a wedge from `origin` spanning bearing ± halfAngle. */
export function wedgeRing(origin: RavenPoint, bearing: number, radiusM = FOV_RADIUS_M, halfAngle = FOV_HALF_ANGLE, steps = 12): Position[] {
  const ring: Position[] = [position(origin)];
  for (let step = 0; step <= steps; step += 1) {
    const angle = bearing - halfAngle + (2 * halfAngle * step) / steps;
    ring.push(position(destinationPoint(origin, angle, radiusM)));
  }
  ring.push(position(origin));
  return ring;
}

/** Field-of-view wedges for every feature whose source publishes a viewing direction. */
export function fovCollection(features: RavenFeature[]) {
  return {
    type: 'FeatureCollection' as const,
    features: features
      .filter(feature => feature.bearing !== undefined)
      .map(feature => ({
        type: 'Feature' as const,
        properties: { id: feature.id },
        geometry: { type: 'Polygon' as const, coordinates: [wedgeRing(feature, feature.bearing!)] }
      }))
  };
}

/** Distance rings around the reference origin, each with a label point on its northern edge. */
export function rangeRingCollection(origin: RavenPoint, radii = RANGE_RING_METERS, steps = 72) {
  const rings = radii.map(meters => ({
    type: 'Feature' as const,
    properties: { meters },
    geometry: {
      type: 'LineString' as const,
      coordinates: Array.from({ length: steps + 1 }, (_, step) => position(destinationPoint(origin, (360 * step) / steps, meters)))
    }
  }));
  const labels = radii.map(meters => ({
    type: 'Feature' as const,
    properties: { meters, label: formatRange(meters).toUpperCase() },
    geometry: { type: 'Point' as const, coordinates: position(destinationPoint(origin, 0, meters)) }
  }));
  return { type: 'FeatureCollection' as const, features: [...rings, ...labels] };
}

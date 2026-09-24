import type { RavenBounds, RavenPoint, RavenViewport } from './types';

const EARTH_RADIUS_M = 6371000;

export function toRad(value: number) { return value * Math.PI / 180; }
export function toDeg(value: number) { return value * 180 / Math.PI; }

export function distanceMeters(aLat: number, aLon: number, bLat: number, bLon: number) {
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export function bearingDegrees(aLat: number, aLon: number, bLat: number, bLon: number) {
  const y = Math.sin(toRad(bLon - aLon)) * Math.cos(toRad(bLat));
  const x = Math.cos(toRad(aLat)) * Math.sin(toRad(bLat)) - Math.sin(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.cos(toRad(bLon - aLon));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Point reached by travelling `meters` from `origin` along great-circle `bearing` (degrees from north). */
export function destinationPoint(origin: RavenPoint, bearing: number, meters: number): RavenPoint {
  const angular = meters / EARTH_RADIUS_M;
  const theta = toRad(bearing);
  const lat1 = toRad(origin.lat);
  const lon1 = toRad(origin.lon);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(theta));
  const lon2 = lon1 + Math.atan2(Math.sin(theta) * Math.sin(angular) * Math.cos(lat1), Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: toDeg(lat2), lon: wrapLongitude(toDeg(lon2)) };
}

export function formatRange(meters: number) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
}

/** Wraps any longitude into [-180, 180). */
export function wrapLongitude(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * MapLibre reports unwrapped longitudes once the map is panned across a world copy
 * (a centre of 280 instead of -80). Providers and the local API only accept real
 * coordinates, so shift the whole viewport back by whole turns until its centre is
 * in range, then clamp any part that still straddles the antimeridian.
 */
export function normalizeViewport(viewport: RavenViewport): RavenViewport {
  const lon = wrapLongitude(viewport.center.lon);
  const shift = viewport.center.lon - lon;
  const bounds: RavenBounds = {
    west: clamp(viewport.bounds.west - shift, -180, 180),
    south: clamp(viewport.bounds.south, -90, 90),
    east: clamp(viewport.bounds.east - shift, -180, 180),
    north: clamp(viewport.bounds.north, -90, 90)
  };
  return { ...viewport, center: { lat: clamp(viewport.center.lat, -90, 90), lon }, bounds };
}

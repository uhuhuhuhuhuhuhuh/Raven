import { describe, expect, it } from 'vitest';
import { bearingDegrees, destinationPoint, distanceMeters, formatRange, normalizeViewport, wrapLongitude } from './geo';

describe('geo helpers', () => {
  it('measures great-circle distance and bearing', () => {
    // One degree of latitude is ~111.2 km on the mean-radius sphere.
    expect(distanceMeters(0, 0, 1, 0)).toBeCloseTo(111_195, -1);
    expect(bearingDegrees(0, 0, 1, 0)).toBeCloseTo(0, 6);
    expect(bearingDegrees(0, 0, 0, 1)).toBeCloseTo(90, 6);
    expect(bearingDegrees(0, 0, -1, 0)).toBeCloseTo(180, 6);
  });

  it('projects a destination point that round-trips through distance and bearing', () => {
    const origin = { lat: 25.7617, lon: -80.1918 };
    const target = destinationPoint(origin, 135, 500);
    expect(distanceMeters(origin.lat, origin.lon, target.lat, target.lon)).toBeCloseTo(500, 3);
    expect(bearingDegrees(origin.lat, origin.lon, target.lat, target.lon)).toBeCloseTo(135, 3);
  });

  it('formats ranges in metres below 1 km and kilometres above', () => {
    expect(formatRange(742.4)).toBe('742 m');
    expect(formatRange(1500)).toBe('1.50 km');
  });

  it('wraps longitudes into [-180, 180)', () => {
    expect(wrapLongitude(280)).toBeCloseTo(-80);
    expect(wrapLongitude(-200)).toBeCloseTo(160);
    expect(wrapLongitude(180)).toBe(-180);
    expect(wrapLongitude(45)).toBe(45);
  });

  it('shifts a viewport panned onto another world copy back to real coordinates', () => {
    const normalized = normalizeViewport({
      center: { lat: 25.76, lon: -80.19 + 360 },
      bounds: { west: -80.3 + 360, south: 25.7, east: -80.1 + 360, north: 25.9 },
      zoom: 12
    });
    expect(normalized.center.lon).toBeCloseTo(-80.19);
    expect(normalized.bounds.west).toBeCloseTo(-80.3);
    expect(normalized.bounds.east).toBeCloseTo(-80.1);
  });

  it('clamps a viewport that straddles the antimeridian instead of emitting invalid longitudes', () => {
    const normalized = normalizeViewport({
      center: { lat: -17.7, lon: 179.5 },
      bounds: { west: 178.5, south: -18.5, east: 180.5, north: -17 },
      zoom: 9
    });
    expect(normalized.bounds.west).toBeCloseTo(178.5);
    expect(normalized.bounds.east).toBe(180);
    expect(normalized.bounds.west).toBeLessThan(normalized.bounds.east);
  });
});

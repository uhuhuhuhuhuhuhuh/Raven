import { describe, expect, it } from 'vitest';
import { matchesFilter } from './filter';
import { bearingDegrees, distanceMeters } from './geo';
import { FOV_HALF_ANGLE, FOV_RADIUS_M, fovCollection, rangeRingCollection, wedgeRing } from './overlays';
import { formatViewHash, parseViewHash } from './permalink';
import { loadPreferences, savePreferences } from './preferences';
import type { LayerKey, RavenFeature } from './types';

const base: RavenFeature = {
  id: 'cam-1', providerId: 'osm-overpass', kind: 'camera', cameraType: 'dome', mediaType: 'none',
  name: 'Main St Camera', operator: 'City of Miami', zone: 'town', lat: 25.76, lon: -80.19,
  fetchedAt: new Date(0).toISOString(), metadata: {}
};

describe('field-of-view and range overlays', () => {
  it('builds a closed wedge whose arc spans the published bearing at the illustrative radius', () => {
    const ring = wedgeRing(base, 90);
    expect(ring[0]).toEqual(ring.at(-1));
    expect(ring[0]).toEqual([base.lon, base.lat]);
    const arc = ring.slice(1, -1);
    for (const [lon, lat] of arc) expect(distanceMeters(base.lat, base.lon, lat, lon)).toBeCloseTo(FOV_RADIUS_M, 3);
    expect(bearingDegrees(base.lat, base.lon, arc[0][1], arc[0][0])).toBeCloseTo(90 - FOV_HALF_ANGLE, 3);
    expect(bearingDegrees(base.lat, base.lon, arc.at(-1)![1], arc.at(-1)![0])).toBeCloseTo(90 + FOV_HALF_ANGLE, 3);
  });

  it('draws wedges only for cameras whose source publishes a facing', () => {
    const collection = fovCollection([{ ...base, bearing: 0 }, { ...base, id: 'no-facing' }, { ...base, id: 'north', bearing: 0 }]);
    expect(collection.features.map(feature => feature.properties.id)).toEqual(['cam-1', 'north']);
  });

  it('draws labelled range rings at their true distance from the origin', () => {
    const collection = rangeRingCollection(base, [500, 1000]);
    const rings = collection.features.filter(feature => feature.geometry.type === 'LineString');
    const labels = collection.features.filter(feature => feature.geometry.type === 'Point');
    expect(rings).toHaveLength(2);
    expect(labels.map(feature => feature.properties)).toEqual([{ meters: 500, label: '500 M' }, { meters: 1000, label: '1.00 KM' }]);
    const [lon, lat] = (rings[1].geometry.coordinates as number[][])[17];
    expect(distanceMeters(base.lat, base.lon, lat, lon)).toBeCloseTo(1000, 3);
  });
});

describe('shareable view permalink', () => {
  it('round-trips an OSM-style #map=zoom/lat/lon fragment', () => {
    const hash = formatViewHash({ zoom: 13.4, lat: 25.7617, lon: -80.1918 });
    expect(hash).toBe('#map=13.40/25.76170/-80.19180');
    expect(parseViewHash(hash)).toEqual({ zoom: 13.4, lat: 25.7617, lon: -80.1918 });
  });

  it('rejects missing, malformed or out-of-range fragments', () => {
    expect(parseViewHash('')).toBeNull();
    expect(parseViewHash('#map=13/abc/1')).toBeNull();
    expect(parseViewHash('#map=13/95/1')).toBeNull();
    expect(parseViewHash('#map=40/10/1')).toBeNull();
    expect(parseViewHash('#map=13/10/1&layers=x')).toEqual({ zoom: 13, lat: 10, lon: 1 });
  });
});

describe('stored preferences', () => {
  const layers: LayerKey[] = ['heat', 'fov'];
  function memoryStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) };
  }

  it('round-trips known layer choices and auto scan', () => {
    const storage = memoryStorage();
    savePreferences({ layers: { heat: true, fov: false }, autoScan: true }, storage);
    expect(loadPreferences(layers, storage)).toEqual({ layers: { heat: true, fov: false }, autoScan: true });
  });

  it('ignores corrupt JSON, unknown layers and non-boolean values', () => {
    expect(loadPreferences(layers, memoryStorage({ 'raven.preferences.v1': '{not json' }))).toEqual({});
    const stale = memoryStorage({ 'raven.preferences.v1': JSON.stringify({ layers: { heat: 'yes', removed: true, fov: true }, autoScan: 1 }) });
    expect(loadPreferences(layers, stale)).toEqual({ layers: { fov: true }, autoScan: undefined });
  });

  it('survives storage that throws, as in privacy modes', () => {
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); } };
    expect(loadPreferences(layers, throwing)).toEqual({});
    expect(() => savePreferences({ autoScan: true }, throwing)).not.toThrow();
  });
});

describe('contact register filter', () => {
  it('matches every term case-insensitively across descriptive fields', () => {
    expect(matchesFilter(base, '')).toBe(true);
    expect(matchesFilter(base, 'main')).toBe(true);
    expect(matchesFilter(base, 'MIAMI dome')).toBe(true);
    expect(matchesFilter(base, 'main caltrans')).toBe(false);
    const register = [base, { ...base, id: 'b', name: 'I-95 NB' }];
    expect(register.filter(feature => matchesFilter(feature, 'i-95')).map(feature => feature.id)).toEqual(['b']);
  });
});

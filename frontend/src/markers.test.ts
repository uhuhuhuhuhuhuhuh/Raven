import { describe, expect, it } from 'vitest';
import { HUES, MARKER_BY_KEY, MARKER_CLASSES, markerKey, markerTag } from './markers';
import type { RavenFeature } from './types';

function feature(overrides: Partial<RavenFeature>): RavenFeature {
  return { id: 'f', providerId: 'osm-overpass', kind: 'camera', mediaType: 'none', lat: 0, lon: 0, fetchedAt: '', metadata: {}, ...overrides };
}

describe('marker classes', () => {
  it('classifies media before camera type, so a streaming camera is never shown as mapped', () => {
    expect(markerKey(feature({ streamUrl: 'https://s.test/live.m3u8', snapshotUrl: 'https://s.test/a.jpg' }))).toBe('stream');
    expect(markerKey(feature({ snapshotUrl: 'https://s.test/a.jpg' }))).toBe('snapshot');
    expect(markerKey(feature({ cameraType: 'alpr' }))).toBe('alpr');
    expect(markerKey(feature({ cameraType: 'speed' }))).toBe('speed');
    expect(markerKey(feature({ cameraType: 'dome' }))).toBe('mapped');
  });

  it('gives every class a unique hue-and-shape pair drawn from the three validated hues', () => {
    const pairs = MARKER_CLASSES.map(item => `${item.color}/${item.shape}`);
    expect(new Set(pairs).size).toBe(MARKER_CLASSES.length);
    expect(new Set(MARKER_CLASSES.map(item => item.color))).toEqual(new Set(Object.values(HUES)));
    expect(new Set(MARKER_CLASSES.map(item => item.layer)).size).toBe(MARKER_CLASSES.length);
    expect(MARKER_BY_KEY.alpr).toMatchObject({ shape: 'diamond', color: HUES.alpr });
  });

  it('tags list rows with the class, or the mapped camera type when known', () => {
    expect(markerTag(feature({ cameraType: 'ptz' }))).toBe('PTZ');
    expect(markerTag(feature({ cameraType: 'dome' }))).toBe('Dome');
    expect(markerTag(feature({ cameraType: 'unknown' }))).toBe('Mapped');
    expect(markerTag(feature({ cameraType: 'alpr' }))).toBe('ALPR');
    expect(markerTag(feature({ snapshotUrl: 'https://s.test/a.jpg' }))).toBe('Snapshot');
  });
});

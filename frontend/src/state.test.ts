import { describe, expect, it } from 'vitest';
import { createInitialState, featureVisible, overallStatus, ravenReducer, visibleFeatures, type RavenState } from './state';
import type { RavenFeature } from './types';

const base = (overrides: Partial<RavenFeature>): RavenFeature => ({
  id: 'f', providerId: 'test', kind: 'camera', mediaType: 'none', lat: 25.76, lon: -80.19, fetchedAt: '2026-01-01T00:00:00Z', metadata: {}, ...overrides
});
const snapshot = base({ id: 'snap', providerId: 'fl511', mediaType: 'snapshot', snapshotUrl: 'https://example.test/a.jpg' });
const stream = base({ id: 'live', providerId: 'caltrans', mediaType: 'stream', snapshotUrl: 'https://example.test/b.jpg', streamUrl: 'https://example.test/b.m3u8' });
const mapped = base({ id: 'osm-node-1', providerId: 'osm-overpass', cameraType: 'fixed' });
const speed = base({ id: 'osm-node-2', providerId: 'osm-overpass', cameraType: 'speed' });
const alpr = base({ id: 'osm-node-3', providerId: 'osm-overpass', cameraType: 'alpr' });

function loaded(): RavenState {
  let state = createInitialState();
  state = ravenReducer(state, { type: 'DATA_SET', set: 'live', patch: { status: 'ready', source: 'catalog', features: [snapshot, stream] } });
  state = ravenReducer(state, { type: 'DATA_SET', set: 'osm', patch: { status: 'ready', source: 'tiles', features: [mapped, speed, alpr] } });
  return state;
}

describe('Raven state', () => {
  it('hides snapshot layers without deleting loaded data', () => {
    const state = ravenReducer(loaded(), { type: 'LAYER_TOGGLE', layer: 'snapshots' });
    expect(visibleFeatures(state).map(feature => feature.id)).not.toContain('snap');
    expect(state.live.features).toHaveLength(2);
    expect(visibleFeatures(ravenReducer(state, { type: 'LAYER_TOGGLE', layer: 'snapshots' })).map(feature => feature.id)).toContain('snap');
  });

  it('shows a dual-capability stream camera when either its stream or snapshot layer is enabled', () => {
    const layers = loaded().layers;
    expect(featureVisible(stream, { ...layers, streams: false })).toBe(true);
    expect(featureVisible(stream, { ...layers, snapshots: false })).toBe(true);
    expect(featureVisible(stream, { ...layers, streams: false, snapshots: false })).toBe(false);
  });

  it('controls speed cameras and plate readers independently of other mapped cameras', () => {
    const layers = loaded().layers;
    expect(featureVisible(speed, { ...layers, mappedCameras: false })).toBe(true);
    expect(featureVisible(speed, { ...layers, speedCameras: false })).toBe(false);
    expect(featureVisible(alpr, { ...layers, mappedCameras: false, speedCameras: false })).toBe(true);
    expect(featureVisible(alpr, { ...layers, alpr: false })).toBe(false);
    expect(featureVisible(mapped, { ...layers, alpr: false, speedCameras: false })).toBe(true);
  });

  it('measures from the map centre until a GPS origin is chosen', () => {
    const viewport = { center: { lat: 34.05, lon: -118.25 }, bounds: { west: -118.3, south: 34, east: -118.2, north: 34.1 }, zoom: 13 };
    const followed = ravenReducer(createInitialState(), { type: 'VIEWPORT_CHANGED', viewport });
    expect(followed.referenceOrigin).toEqual({ lat: 34.05, lon: -118.25, source: 'map' });
    const pinned = ravenReducer(followed, { type: 'REFERENCE_ORIGIN_SET', point: { lat: 1, lon: 2 }, source: 'gps' });
    const moved = ravenReducer(pinned, { type: 'VIEWPORT_CHANGED', viewport: { ...viewport, center: { lat: 35, lon: -119 } } });
    expect(moved.referenceOrigin).toEqual({ lat: 1, lon: 2, source: 'gps' });
  });

  it('selection changes do not touch the viewport or data', () => {
    const state = loaded();
    const selected = ravenReducer(state, { type: 'SELECT', id: 'snap' });
    expect(selected.viewport).toBe(state.viewport);
    expect(selected.live).toBe(state.live);
    expect(selected.selectionId).toBe('snap');
  });

  it('summarises the two data sets for the status pill', () => {
    const state = loaded();
    expect(overallStatus(state)).toBe('ready');
    expect(overallStatus(ravenReducer(state, { type: 'DATA_SET', set: 'osm', patch: { status: 'loading' } }))).toBe('loading');
    expect(overallStatus(ravenReducer(state, { type: 'DATA_SET', set: 'osm', patch: { status: 'error' } }))).toBe('partial');
    expect(overallStatus(ravenReducer(ravenReducer(state, { type: 'DATA_SET', set: 'osm', patch: { status: 'error' } }), { type: 'DATA_SET', set: 'live', patch: { status: 'error' } }))).toBe('error');
  });
});

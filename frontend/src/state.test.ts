import { describe, expect, it } from 'vitest';
import { allFeatures, createInitialState, ravenReducer, visibleFeatures } from './state';
import type { RavenFeature } from './types';

const snapshot: RavenFeature = {
  id: 'snapshot-1', providerId: 'fl511-public-cameras', kind: 'camera', cameraType: 'fixed', mediaType: 'snapshot',
  name: 'Snapshot Camera', lat: 25.76, lon: -80.19, snapshotUrl: 'https://example.test/cam.jpg', fetchedAt: new Date().toISOString(), metadata: {}
};
const mapped: RavenFeature = {
  id: 'mapped-1', providerId: 'osm-overpass', kind: 'camera', cameraType: 'fixed', mediaType: 'none',
  name: 'Mapped Camera', lat: 25.77, lon: -80.18, fetchedAt: new Date().toISOString(), metadata: {}
};
const speed: RavenFeature = {
  id: 'speed-1', providerId: 'osm-overpass', kind: 'camera', cameraType: 'speed', mediaType: 'none',
  name: 'Speed Camera', lat: 25.78, lon: -80.17, fetchedAt: new Date().toISOString(), metadata: {}
};
const streamWithSnapshot: RavenFeature = {
  id: 'stream-1', providerId: 'caltrans-cctv', kind: 'camera', cameraType: 'fixed', mediaType: 'stream',
  name: 'Stream Camera', lat: 34.05, lon: -118.25, snapshotUrl: 'https://example.test/fallback.jpg',
  streamPageUrl: 'https://cwwp2.dot.ca.gov/vm/loc/d7/test.htm', fetchedAt: new Date().toISOString(), metadata: {}
};

function loadedState() {
  let state = createInitialState();
  state = ravenReducer(state, {
    type: 'SCAN_BEGIN', id: 'scan-a', bounds: state.viewport.bounds, center: state.viewport.center,
    activeProviderIds: ['osm-overpass', 'fl511-public-cameras'],
    allProviderIds: ['osm-overpass', 'fl511-public-cameras', 'caltrans-cctv'],
    skipReasons: { 'caltrans-cctv': 'OUTSIDE COVERAGE' }, timestamp: 1
  });
  state = ravenReducer(state, { type: 'PROVIDER_SUCCESS', scanId: 'scan-a', providerId: 'osm-overpass', features: [mapped, speed], timestamp: 2 });
  state = ravenReducer(state, { type: 'PROVIDER_SUCCESS', scanId: 'scan-a', providerId: 'fl511-public-cameras', features: [snapshot], timestamp: 2 });
  state = ravenReducer(state, { type: 'SCAN_FINISH', scanId: 'scan-a', status: 'ready', timestamp: 3 });
  return state;
}

describe('Raven state invariants', () => {
  it('hides snapshot layers without deleting fetched provider data', () => {
    let state = loadedState();
    expect(allFeatures(state)).toHaveLength(3);
    expect(visibleFeatures(state).some(feature => feature.id === snapshot.id)).toBe(true);
    state = ravenReducer(state, { type: 'LAYER_SET', layer: 'snapshots', value: false });
    expect(allFeatures(state)).toHaveLength(3);
    expect(visibleFeatures(state).some(feature => feature.id === snapshot.id)).toBe(false);
    state = ravenReducer(state, { type: 'LAYER_SET', layer: 'snapshots', value: true });
    expect(visibleFeatures(state).some(feature => feature.id === snapshot.id)).toBe(true);
  });

  it('marks results dirty when the viewport moves after a completed scan', () => {
    let state = loadedState();
    state = ravenReducer(state, {
      type: 'VIEWPORT_CHANGED',
      viewport: { ...state.viewport, bounds: { ...state.viewport.bounds, east: state.viewport.bounds.east + 0.02 } }
    });
    expect(state.scan.status).toBe('dirty');
  });

  it('ignores late provider results from an obsolete scan', () => {
    let state = loadedState();
    state = ravenReducer(state, {
      type: 'SCAN_BEGIN', id: 'scan-b', bounds: state.viewport.bounds, center: state.viewport.center,
      activeProviderIds: ['osm-overpass'], allProviderIds: ['osm-overpass', 'fl511-public-cameras', 'caltrans-cctv'], timestamp: 4
    });
    state = ravenReducer(state, { type: 'PROVIDER_SUCCESS', scanId: 'scan-a', providerId: 'osm-overpass', features: [mapped], timestamp: 5 });
    expect(state.providers['osm-overpass'].scanId).toBe('scan-b');
    expect(state.providers['osm-overpass'].features).toHaveLength(0);
  });

  it('keeps speed cameras independently controllable from the general mapped-camera layer', () => {
    let state = loadedState();
    state = ravenReducer(state, { type: 'LAYER_SET', layer: 'mappedCameras', value: false });
    const visible = visibleFeatures(state);
    expect(visible.some(feature => feature.id === mapped.id)).toBe(false);
    expect(visible.some(feature => feature.id === speed.id)).toBe(true);
  });

  it('selection changes do not mutate viewport or scan bounds', () => {
    const state = loadedState();
    const next = ravenReducer(state, { type: 'SELECT', id: snapshot.id });
    expect(next.viewport).toEqual(state.viewport);
    expect(next.scan.bounds).toEqual(state.scan.bounds);
  });

  it('shows a dual-capability stream camera when either its stream or snapshot layer is enabled', () => {
    let state = loadedState();
    state = ravenReducer(state, {
      type: 'PROVIDER_SUCCESS', scanId: 'scan-a', providerId: 'caltrans-cctv', features: [streamWithSnapshot], timestamp: 4
    });
    state = ravenReducer(state, { type: 'LAYER_SET', layer: 'streams', value: false });
    expect(visibleFeatures(state).some(feature => feature.id === streamWithSnapshot.id)).toBe(true);
    state = ravenReducer(state, { type: 'LAYER_SET', layer: 'snapshots', value: false });
    expect(visibleFeatures(state).some(feature => feature.id === streamWithSnapshot.id)).toBe(false);
    state = ravenReducer(state, { type: 'LAYER_SET', layer: 'streams', value: true });
    expect(visibleFeatures(state).some(feature => feature.id === streamWithSnapshot.id)).toBe(true);
  });

  it('preserves progressive provider results while a provider is loading', () => {
    let state = loadedState();
    state = ravenReducer(state, {
      type: 'SCAN_BEGIN', id: 'scan-c', bounds: state.viewport.bounds, center: state.viewport.center,
      activeProviderIds: ['osm-overpass'], allProviderIds: ['osm-overpass'], timestamp: 10
    });
    state = ravenReducer(state, {
      type: 'PROVIDER_PROGRESS', scanId: 'scan-c', providerId: 'osm-overpass', features: [mapped],
      progress: { completed: 1, total: 4 }, timestamp: 11
    });
    expect(state.providers['osm-overpass'].status).toBe('loading');
    expect(state.providers['osm-overpass'].features).toEqual([mapped]);
    expect(state.providers['osm-overpass'].progress).toEqual({ completed: 1, total: 4 });
  });
});

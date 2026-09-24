import { describe, expect, it } from 'vitest';
import { buildStaticApi, toApiCamera } from './staticApi';
import type { RavenFeature } from './types';

const hls: RavenFeature = {
  id: 'caltrans-2', providerId: 'caltrans-cctv', kind: 'camera', cameraType: 'fixed', mediaType: 'stream', mediaHealth: 'active',
  name: 'I-680 : Sheridan Rd', lat: 37.561661234, lon: -121.904889876, zone: 'Alameda', directionLabel: 'North', operator: 'Caltrans',
  snapshotUrl: 'https://example.test/still.jpg', streamUrl: 'https://wzmedia.dot.ca.gov/D4/cam.stream/playlist.m3u8',
  attribution: 'Caltrans / State of California', fetchedAt: '2026-01-01T00:00:00Z', metadata: { raw: 'omitted from the API' }
};
const snapshotOnly: RavenFeature = { ...hls, id: 'caltrans-1', mediaType: 'snapshot', streamUrl: undefined };
const florida: RavenFeature = { ...snapshotOnly, id: 'fl511-9', providerId: 'fl511-public-cameras', attribution: 'FL511' };

describe('static camera API', () => {
  it('maps features to compact records that keep attribution and published media URLs verbatim', () => {
    const record = toApiCamera(hls);
    expect(record).toMatchObject({
      id: 'caltrans-2', provider: 'caltrans-cctv', lat: 37.561661, lon: -121.90489, direction: 'North', zone: 'Alameda',
      snapshotUrl: 'https://example.test/still.jpg', attribution: 'Caltrans / State of California',
      stream: { url: 'https://wzmedia.dot.ca.gov/D4/cam.stream/playlist.m3u8', format: 'hls' }
    });
    expect(record).not.toHaveProperty('metadata');
    expect(toApiCamera({ ...hls, streamUrl: 'https://example.test/clip.mp4' }).stream?.format).toBe('progressive');
    expect(toApiCamera(snapshotOnly).stream).toBeUndefined();
  });

  it('lists every camera, only playable streams in streams.json, and per-provider health', () => {
    const files = buildStaticApi([
      { id: 'fl511-public-cameras', name: 'FL511', attribution: 'FL511', features: [florida] },
      { id: 'caltrans-cctv', name: 'Caltrans', attribution: 'Caltrans', features: [hls, snapshotOnly], warning: 'PAGE 2 FAILED' },
      { id: 'down', name: 'Down', attribution: 'Down', error: 'HTTP 503' }
    ], '2026-01-01T00:00:00Z', { osmTiles: 'osm/index.json' });

    expect(files['cameras.json'].cameras.map(camera => camera.id)).toEqual(['caltrans-1', 'caltrans-2', 'fl511-9']);
    expect(files['streams.json']).toMatchObject({ count: 1, streams: [{ id: 'caltrans-2' }] });
    expect(files['index.json'].endpoints).toEqual({
      cameras: 'cameras.json', streams: 'streams.json', camerasGeoJson: 'cameras.geojson', streamsGeoJson: 'streams.geojson', osmTiles: 'osm/index.json'
    });
    expect(files['streams.geojson'].features).toEqual([{
      type: 'Feature', id: 'caltrans-2',
      geometry: { type: 'Point', coordinates: [-121.90489, 37.561661] },
      properties: expect.objectContaining({ id: 'caltrans-2', provider: 'caltrans-cctv', stream: { url: hls.streamUrl, format: 'hls' } })
    }]);
    expect(files['cameras.geojson'].features).toHaveLength(3);
    expect(files['index.json'].providers).toEqual([
      { id: 'fl511-public-cameras', name: 'FL511', attribution: 'FL511', status: 'ok', cameras: 1, streams: 0 },
      { id: 'caltrans-cctv', name: 'Caltrans', attribution: 'Caltrans', status: 'partial', cameras: 2, streams: 1, warning: 'PAGE 2 FAILED' },
      { id: 'down', name: 'Down', attribution: 'Down', status: 'error', cameras: 0, streams: 0, error: 'HTTP 503' }
    ]);
  });
});

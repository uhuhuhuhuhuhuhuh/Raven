import { describe, expect, it } from 'vitest';
import { featuresToGeoJson } from './exportGeoJson';
import { osmAddUrl, osmEditUrl } from './osmLinks';
import type { RavenFeature } from './types';

const osm: RavenFeature = {
  id: 'osm-node-42', providerId: 'osm-overpass', kind: 'camera', cameraType: 'alpr', mediaType: 'none', manufacturer: 'Flock Safety',
  name: 'Plate Reader', lat: 25.76, lon: -80.19, bearing: 45, attribution: '© OpenStreetMap contributors', fetchedAt: '', metadata: { secret: 'not exported' }
};
const traffic: RavenFeature = {
  id: 'caltrans-7', providerId: 'caltrans-cctv', kind: 'camera', mediaType: 'stream', name: 'I-5', lat: 38.5, lon: -121.5,
  streamUrl: 'https://wzmedia.dot.ca.gov/D3/cam.stream/playlist.m3u8', attribution: 'Caltrans / State of California', fetchedAt: '', metadata: {}
};

describe('OpenStreetMap editing links', () => {
  it('opens the editor on OSM records only', () => {
    expect(osmEditUrl(osm)).toBe('https://www.openstreetmap.org/edit?node=42');
    expect(osmEditUrl({ ...osm, id: 'osm-way-7' })).toBe('https://www.openstreetmap.org/edit?way=7');
    expect(osmEditUrl(traffic)).toBeUndefined();
  });

  it('opens the editor zoomed in on a point for mapping a missing camera', () => {
    expect(osmAddUrl({ lat: 25.7617, lon: -80.1918 })).toBe('https://www.openstreetmap.org/edit#map=19/25.76170/-80.19180');
  });
});

describe('GeoJSON export', () => {
  it('exports points with descriptive properties and every source attribution', () => {
    const collection = featuresToGeoJson([osm, traffic, { ...osm, id: 'osm-node-43' }], '2026-09-24T00:00:00Z');
    expect(collection.attribution).toEqual(['Caltrans / State of California', '© OpenStreetMap contributors']);
    expect(collection.features[0]).toMatchObject({
      type: 'Feature', id: 'osm-node-42',
      geometry: { type: 'Point', coordinates: [-80.19, 25.76] },
      properties: { provider: 'osm-overpass', cameraType: 'alpr', manufacturer: 'Flock Safety', bearing: 45 }
    });
    expect(collection.features[1].properties.streamUrl).toBe(traffic.streamUrl);
    expect(JSON.stringify(collection)).not.toContain('not exported');
  });
});

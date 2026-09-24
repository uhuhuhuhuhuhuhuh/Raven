import type { StyleSpecification } from 'maplibre-gl';

/**
 * Basemap: OpenFreeMap's dark vector style (free, keyless, cookie-free, and built for
 * app traffic, unlike the volunteer-run tile.openstreetmap.org), tinted to Raven's
 * palette. If it cannot be loaded, the map falls back to OSM raster tiles so it
 * never fails to start.
 */
export const OPENFREEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';
const STYLE_TIMEOUT_MS = 6000;

export type Basemap = {
  style: StyleSpecification;
  /** A fontstack the style's glyph server provides, for Raven's own labels. */
  textFont: string[];
  source: 'openfreemap' | 'fallback';
};

export const FALLBACK_BASEMAP: Basemap = {
  source: 'fallback',
  textFont: ['Open Sans Bold'],
  style: {
    version: 8,
    glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors'
      }
    },
    layers: [{
      id: 'osm',
      type: 'raster',
      source: 'osm',
      paint: {
        'raster-saturation': -0.85,
        'raster-brightness-min': 0.12,
        'raster-brightness-max': 0.48,
        'raster-contrast': 0.3,
        'raster-hue-rotate': 70
      }
    }]
  }
};

/** Recolours the style's background and water to Raven's dark green palette. */
export function tintStyle(style: StyleSpecification): StyleSpecification {
  return {
    ...style,
    layers: style.layers.map(layer => {
      if (layer.type === 'background') return { ...layer, paint: { ...layer.paint, 'background-color': '#07100d' } };
      if (layer.type === 'fill' && layer.id === 'water') return { ...layer, paint: { ...layer.paint, 'fill-color': '#0b1a16' } };
      return layer;
    })
  };
}

export async function loadBasemap(): Promise<Basemap> {
  try {
    const response = await fetch(OPENFREEMAP_STYLE_URL, { signal: AbortSignal.timeout(STYLE_TIMEOUT_MS), headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`style request failed (${response.status})`);
    const style = (await response.json()) as StyleSpecification;
    if (style?.version !== 8 || !Array.isArray(style.layers) || !style.glyphs) throw new Error('unexpected style document');
    return { style: tintStyle(style), textFont: ['Noto Sans Bold'], source: 'openfreemap' };
  } catch {
    return FALLBACK_BASEMAP;
  }
}

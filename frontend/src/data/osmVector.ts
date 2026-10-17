import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import type { OsmTileIndex } from '../providers/osmTiles';
import type { RavenFeature } from '../types';

/**
 * OpenStreetMap cameras as vector tiles. scripts/build_osm_tiles.py writes
 * osm/cameras.pmtiles (one PMTiles archive, three layers named after the marker
 * classes, points clustered below zoom 14). The browser reads only the few-kilobyte
 * tiles in view through HTTP range requests, so the national dataset renders at any
 * zoom without downloading or clustering anything client-side.
 */
export const OSM_SOURCE = 'osm-cameras';
export const OSM_CLASSES = ['alpr', 'speed', 'mapped'] as const;
export type OsmClass = (typeof OSM_CLASSES)[number];

let protocolRegistered = false;

export function registerPmtilesProtocol(): void {
  if (protocolRegistered) return;
  maplibregl.addProtocol('pmtiles', new Protocol().tile);
  protocolRegistered = true;
}

/** `pmtiles://…/osm/cameras.pmtiles`, or null when the deploy published no vector tiles. */
export function osmVectorUrl(apiBase: string, index: OsmTileIndex | null): string | null {
  if (!index?.vectorTiles) return null;
  return `pmtiles://${new URL(`osm/${index.vectorTiles}`, apiBase).href}`;
}

export type OsmTileProperties = { k?: string; b?: number; nm?: string; op?: string; mf?: string; point_count?: number };

export function osmFeatureId(nodeId: number | string): string {
  return `osm-node-${nodeId}`;
}

/** The light RavenFeature a tile point carries; full tags arrive with osmNodeDetail(). */
export function osmTileFeature(nodeId: number | string, properties: OsmTileProperties, lon: number, lat: number, attribution: string): RavenFeature {
  const cameraType = properties.k === 'alpr' ? 'alpr' : properties.k === 'speed' ? 'speed' : 'unknown';
  return {
    id: osmFeatureId(nodeId),
    providerId: 'osm-overpass',
    sourceId: String(nodeId),
    kind: 'camera',
    cameraType,
    mediaType: 'none',
    mediaHealth: 'unknown',
    name: properties.nm || properties.op || (cameraType === 'alpr' ? 'Plate reader' : cameraType === 'speed' ? 'Speed camera' : 'Mapped camera'),
    lat,
    lon,
    bearing: typeof properties.b === 'number' ? properties.b : undefined,
    directionLabel: typeof properties.b === 'number' ? `${properties.b}°` : undefined,
    operator: properties.op,
    manufacturer: properties.mf,
    sourceUrl: `https://www.openstreetmap.org/node/${nodeId}`,
    attribution,
    fetchedAt: new Date().toISOString(),
    metadata: {}
  };
}

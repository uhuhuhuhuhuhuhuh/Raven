import { useEffect, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import { CAMERA_COLORS } from '../colors';
import { normalizeViewport } from '../geo';
import { fovCollection, rangeRingCollection } from '../overlays';
import type { MapView } from '../permalink';
import type { RavenBounds, RavenFeature, RavenPoint, RavenViewport } from '../types';

// Symbol layers (cluster counts) cannot render text without a glyph source.
const GLYPHS_URL = 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf';

export type MapFocus = { lat: number; lon: number; zoom: number; token: number } | null;

const EMPTY_COLLECTION = { type: 'FeatureCollection' as const, features: [] };

function featureCollection(features: RavenFeature[], selectedId: string | null) {
  return {
    type: 'FeatureCollection' as const,
    features: features.map(feature => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [feature.lon, feature.lat] },
      properties: {
        id: feature.id,
        selected: feature.id === selectedId,
        cameraType: feature.cameraType || 'unknown',
        mediaType: feature.mediaType,
        providerId: feature.providerId
      }
    }))
  };
}

function boundsPolygon(bounds?: RavenBounds) {
  return {
    type: 'FeatureCollection' as const,
    features: bounds ? [{
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'Polygon' as const,
        coordinates: [[
          [bounds.west, bounds.south],
          [bounds.east, bounds.south],
          [bounds.east, bounds.north],
          [bounds.west, bounds.north],
          [bounds.west, bounds.south]
        ]]
      }
    }] : []
  };
}

export function RavenMap({
  initialView,
  features,
  selectedId,
  scanBounds,
  origin,
  heatEnabled,
  outlineEnabled,
  fovEnabled,
  ringsEnabled,
  focus,
  onViewportChange,
  onSelect
}: {
  initialView: MapView;
  features: RavenFeature[];
  selectedId: string | null;
  scanBounds?: RavenBounds;
  origin: RavenPoint;
  heatEnabled: boolean;
  outlineEnabled: boolean;
  fovEnabled: boolean;
  ringsEnabled: boolean;
  focus: MapFocus;
  onViewportChange: (viewport: RavenViewport) => void;
  onSelect: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  // Overlay effects re-run once the style loads, so props set before then are not lost.
  const [ready, setReady] = useState(false);
  const initialViewRef = useRef(initialView);
  const onViewportRef = useRef(onViewportChange);
  const onSelectRef = useRef(onSelect);

  useEffect(() => { onViewportRef.current = onViewportChange; }, [onViewportChange]);
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      center: [initialViewRef.current.lon, initialViewRef.current.lat],
      zoom: initialViewRef.current.zoom,
      attributionControl: { compact: true },
      style: {
        version: 8,
        glyphs: GLYPHS_URL,
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
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');

    const emitViewport = () => {
      const center = map.getCenter();
      const bounds = map.getBounds();
      onViewportRef.current(normalizeViewport({
        center: { lat: center.lat, lon: center.lng },
        bounds: {
          west: bounds.getWest(),
          south: bounds.getSouth(),
          east: bounds.getEast(),
          north: bounds.getNorth()
        },
        zoom: map.getZoom()
      }));
    };

    map.on('load', () => {
      map.addSource('contacts', {
        type: 'geojson',
        data: featureCollection([], null),
        cluster: true,
        clusterRadius: 48,
        clusterMaxZoom: 14
      });
      map.addSource('contacts-heat', { type: 'geojson', data: featureCollection([], null) });
      map.addSource('scan-area', { type: 'geojson', data: boundsPolygon() });
      map.addSource('fov', { type: 'geojson', data: EMPTY_COLLECTION });
      map.addSource('rings', { type: 'geojson', data: EMPTY_COLLECTION });

      map.addLayer({
        id: 'contacts-heat',
        type: 'heatmap',
        source: 'contacts-heat',
        maxzoom: 16,
        paint: {
          'heatmap-weight': 0.75,
          'heatmap-intensity': 1.1,
          'heatmap-radius': 28,
          'heatmap-opacity': 0
        }
      });

      map.addLayer({
        id: 'rings-line',
        type: 'line',
        source: 'rings',
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { visibility: 'none' },
        paint: { 'line-color': '#65f0b5', 'line-width': 1, 'line-opacity': 0.45, 'line-dasharray': [4, 3] }
      });
      map.addLayer({
        id: 'rings-label',
        type: 'symbol',
        source: 'rings',
        filter: ['==', ['geometry-type'], 'Point'],
        layout: { visibility: 'none', 'text-field': ['get', 'label'], 'text-font': ['Open Sans Bold'], 'text-size': 10, 'text-offset': [0, -0.8] },
        paint: { 'text-color': '#65f0b5', 'text-halo-color': '#07100d', 'text-halo-width': 1.5 }
      });

      // Wedges are tens of metres across, so they only read once zoomed in.
      map.addLayer({ id: 'fov-fill', type: 'fill', source: 'fov', minzoom: 15, layout: { visibility: 'none' }, paint: { 'fill-color': '#62f2ff', 'fill-opacity': 0.12 } });
      map.addLayer({ id: 'fov-line', type: 'line', source: 'fov', minzoom: 15, layout: { visibility: 'none' }, paint: { 'line-color': '#62f2ff', 'line-width': 1, 'line-opacity': 0.5 } });

      map.addLayer({
        id: 'clusters',
        type: 'circle',
        source: 'contacts',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#153d32',
          'circle-stroke-color': '#65f0b5',
          'circle-stroke-width': 1.5,
          'circle-radius': ['step', ['get', 'point_count'], 16, 25, 20, 100, 25, 500, 31],
          'circle-opacity': 0.93
        }
      });

      map.addLayer({
        id: 'cluster-count',
        type: 'symbol',
        source: 'contacts',
        filter: ['has', 'point_count'],
        layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Open Sans Bold'], 'text-size': 11 },
        paint: { 'text-color': '#d9ffec' }
      });

      map.addLayer({
        id: 'contacts-points',
        type: 'circle',
        source: 'contacts',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-radius': ['case', ['==', ['get', 'selected'], true], 8, 5.5],
          'circle-color': [
            'case',
            ['==', ['get', 'selected'], true], CAMERA_COLORS.stream,
            ['==', ['get', 'mediaType'], 'stream'], CAMERA_COLORS.stream,
            ['==', ['get', 'mediaType'], 'snapshot'], CAMERA_COLORS.snapshot,
            ['==', ['get', 'cameraType'], 'alpr'], CAMERA_COLORS.alpr,
            ['==', ['get', 'cameraType'], 'speed'], CAMERA_COLORS.speed,
            CAMERA_COLORS.mapped
          ],
          'circle-stroke-color': '#07100d',
          'circle-stroke-width': 2,
          'circle-opacity': 0.96
        }
      });

      map.addLayer({ id: 'scan-area-fill', type: 'fill', source: 'scan-area', paint: { 'fill-color': '#65f0b5', 'fill-opacity': 0.025 } });
      map.addLayer({ id: 'scan-area-line', type: 'line', source: 'scan-area', paint: { 'line-color': '#65f0b5', 'line-width': 1.2, 'line-opacity': 0.7, 'line-dasharray': [2, 2] } });

      map.on('click', 'contacts-points', event => {
        const id = event.features?.[0]?.properties?.id;
        if (id) onSelectRef.current(String(id));
      });

      map.on('click', 'clusters', event => {
        const feature = event.features?.[0];
        const clusterId = Number(feature?.properties?.cluster_id);
        const coordinates = (feature?.geometry as any)?.coordinates as [number, number] | undefined;
        if (!Number.isFinite(clusterId) || !coordinates) return;
        const source = map.getSource('contacts') as any;
        Promise.resolve(source.getClusterExpansionZoom(clusterId)).then((zoom: number) => {
          map.easeTo({ center: coordinates, zoom });
        }).catch(() => undefined);
      });

      for (const layer of ['contacts-points', 'clusters']) {
        map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
      }
      emitViewport();
      setReady(true);
    });

    map.on('moveend', emitViewport);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const data = featureCollection(features, selectedId);
    (map.getSource('contacts') as GeoJSONSource | undefined)?.setData(data as any);
    (map.getSource('contacts-heat') as GeoJSONSource | undefined)?.setData(data as any);
  }, [ready, features, selectedId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource('scan-area') as GeoJSONSource | undefined)?.setData(boundsPolygon(scanBounds) as any);
    map.setPaintProperty('scan-area-line', 'line-opacity', outlineEnabled ? 0.7 : 0);
    map.setPaintProperty('scan-area-fill', 'fill-opacity', outlineEnabled ? 0.025 : 0);
  }, [ready, scanBounds, outlineEnabled]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setPaintProperty('contacts-heat', 'heatmap-opacity', heatEnabled ? 0.72 : 0);
  }, [ready, heatEnabled]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource('fov') as GeoJSONSource | undefined)?.setData(fovEnabled ? fovCollection(features) : EMPTY_COLLECTION);
    for (const layer of ['fov-fill', 'fov-line']) map.setLayoutProperty(layer, 'visibility', fovEnabled ? 'visible' : 'none');
  }, [ready, features, fovEnabled]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource('rings') as GeoJSONSource | undefined)?.setData(ringsEnabled ? rangeRingCollection(origin) : EMPTY_COLLECTION);
    for (const layer of ['rings-line', 'rings-label']) map.setLayoutProperty(layer, 'visibility', ringsEnabled ? 'visible' : 'none');
  }, [ready, origin, ringsEnabled]);

  useEffect(() => {
    if (!focus || !mapRef.current) return;
    // Not marked essential, so MapLibre jumps instead of flying when the user prefers reduced motion.
    mapRef.current.flyTo({ center: [focus.lon, focus.lat], zoom: focus.zoom });
  }, [focus]);

  return <div ref={containerRef} className="map-canvas" aria-label="Raven public camera map" />;
}

import { useEffect, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import { loadBasemap, type Basemap } from '../basemap';
import { normalizeViewport } from '../geo';
import { MARKER_CLASSES, markerBitmap, markerKey } from '../markers';
import { fovCollection, rangeRingCollection } from '../overlays';
import type { MapView } from '../permalink';
import type { RavenBounds, RavenFeature, RavenPoint, RavenViewport } from '../types';

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
        marker: `marker-${markerKey(feature)}`,
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
  recentPoints,
  recentEnabled,
  focus,
  onViewportChange,
  onSelect,
  onBasemap
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
  /** [lon, lat] of cameras newly mapped in OSM since the previous weekly extract. */
  recentPoints: Array<[number, number]>;
  recentEnabled: boolean;
  focus: MapFocus;
  onViewportChange: (viewport: RavenViewport) => void;
  onSelect: (id: string) => void;
  onBasemap?: (source: Basemap['source']) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  // Overlay effects re-run once the style loads, so props set before then are not lost.
  const [ready, setReady] = useState(false);
  const initialViewRef = useRef(initialView);
  const onViewportRef = useRef(onViewportChange);
  const onSelectRef = useRef(onSelect);
  const onBasemapRef = useRef(onBasemap);

  useEffect(() => { onViewportRef.current = onViewportChange; }, [onViewportChange]);
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);
  useEffect(() => { onBasemapRef.current = onBasemap; }, [onBasemap]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let created: MapLibreMap | undefined;

    const createMap = (basemap: Basemap) => {
      const map = new maplibregl.Map({
        container,
        center: [initialViewRef.current.lon, initialViewRef.current.lat],
        zoom: initialViewRef.current.zoom,
        attributionControl: { compact: true },
        style: basemap.style
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
        map.addSource('recent', { type: 'geojson', data: EMPTY_COLLECTION });

        map.addLayer({
          id: 'contacts-heat',
          type: 'heatmap',
          source: 'contacts-heat',
          maxzoom: 16,
          paint: {
            'heatmap-weight': 0.75,
            'heatmap-intensity': 1.1,
            'heatmap-radius': 28,
            'heatmap-opacity': 0,
            // Magnitude is sequential: one hue, dark to light on the dark map.
            'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
              0, 'rgba(24, 79, 149, 0)', 0.2, '#184f95', 0.45, '#2a78d6', 0.7, '#6da7ec', 1, '#cde2fb']
          }
        });

        map.addLayer({
          id: 'rings-line',
          type: 'line',
          source: 'rings',
          filter: ['==', ['geometry-type'], 'LineString'],
          layout: { visibility: 'none' },
          paint: { 'line-color': '#8b97ab', 'line-width': 1, 'line-opacity': 0.55, 'line-dasharray': [4, 3] }
        });
        map.addLayer({
          id: 'rings-label',
          type: 'symbol',
          source: 'rings',
          filter: ['==', ['geometry-type'], 'Point'],
          layout: { visibility: 'none', 'text-field': ['get', 'label'], 'text-font': basemap.textFont, 'text-size': 10, 'text-offset': [0, -0.8] },
          paint: { 'text-color': '#c1cad8', 'text-halo-color': '#0a0e15', 'text-halo-width': 1.5 }
        });

        // Wedges are tens of metres across, so they only read once zoomed in.
        map.addLayer({ id: 'fov-fill', type: 'fill', source: 'fov', minzoom: 15, layout: { visibility: 'none' }, paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.08 } });
        map.addLayer({ id: 'fov-line', type: 'line', source: 'fov', minzoom: 15, layout: { visibility: 'none' }, paint: { 'line-color': '#ffffff', 'line-width': 1, 'line-opacity': 0.3 } });

        map.addLayer({
          id: 'recent-halo',
          type: 'circle',
          source: 'recent',
          layout: { visibility: 'none' },
          paint: { 'circle-radius': 10, 'circle-opacity': 0, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.85 }
        });

        map.addLayer({
          id: 'clusters',
          type: 'circle',
          source: 'contacts',
          filter: ['has', 'point_count'],
          paint: {
            'circle-color': '#141b2b',
            'circle-stroke-color': '#8b93ff',
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
          layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': basemap.textFont, 'text-size': 11 },
          paint: { 'text-color': '#f3f6fb' }
        });

        map.addLayer({
          id: 'contacts-selected',
          type: 'circle',
          source: 'contacts',
          filter: ['all', ['!', ['has', 'point_count']], ['==', ['get', 'selected'], true]],
          paint: { 'circle-radius': 16, 'circle-color': '#ffffff', 'circle-opacity': 0.08, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 }
        });

        // Class is encoded twice: hue and shape (see markers.ts).
        for (const item of MARKER_CLASSES) map.addImage(`marker-${item.key}`, markerBitmap(item), { pixelRatio: 2 });
        map.addLayer({
          id: 'contacts-points',
          type: 'symbol',
          source: 'contacts',
          filter: ['!', ['has', 'point_count']],
          layout: {
            'icon-image': ['get', 'marker'],
            'icon-size': ['case', ['==', ['get', 'selected'], true], 1.3, 1],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true
          }
        });

        map.addLayer({ id: 'scan-area-fill', type: 'fill', source: 'scan-area', paint: { 'fill-color': '#8b93ff', 'fill-opacity': 0.03 } });
        map.addLayer({ id: 'scan-area-line', type: 'line', source: 'scan-area', paint: { 'line-color': '#8b93ff', 'line-width': 1.2, 'line-opacity': 0.75, 'line-dasharray': [2, 2] } });

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
      return map;
    };

    void loadBasemap().then(basemap => {
      if (cancelled) return;
      onBasemapRef.current?.(basemap.source);
      created = createMap(basemap);
      mapRef.current = created;
    });

    return () => {
      cancelled = true;
      created?.remove();
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
    map.setPaintProperty('scan-area-line', 'line-opacity', outlineEnabled ? 0.75 : 0);
    map.setPaintProperty('scan-area-fill', 'fill-opacity', outlineEnabled ? 0.03 : 0);
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
    const map = mapRef.current;
    if (!map || !ready) return;
    const data = {
      type: 'FeatureCollection' as const,
      features: recentEnabled ? recentPoints.map(coordinates => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates } })) : []
    };
    (map.getSource('recent') as GeoJSONSource | undefined)?.setData(data);
    map.setLayoutProperty('recent-halo', 'visibility', recentEnabled ? 'visible' : 'none');
  }, [ready, recentPoints, recentEnabled]);

  useEffect(() => {
    if (!focus || !mapRef.current) return;
    // Not marked essential, so MapLibre jumps instead of flying when the user prefers reduced motion.
    mapRef.current.flyTo({ center: [focus.lon, focus.lat], zoom: focus.zoom });
  }, [focus]);

  return <div ref={containerRef} className="map-canvas" aria-label="Raven public camera map" />;
}

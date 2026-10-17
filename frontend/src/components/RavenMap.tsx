import { useEffect, useRef, useState } from 'react';
import maplibregl, { type GeoJSONFeature, type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import { loadBasemap, type Basemap } from '../basemap';
import { inBounds } from '../data/bounds';
import { OSM_CLASSES, OSM_SOURCE, osmFeatureId, osmTileFeature, registerPmtilesProtocol, type OsmClass, type OsmTileProperties } from '../data/osmVector';
import { normalizeViewport } from '../geo';
import { HUES, MARKER_CLASSES, markerBitmap, markerKey } from '../markers';
import { fovCollection, rangeRingCollection } from '../overlays';
import type { MapView } from '../permalink';
import type { LayerKey, RavenBounds, RavenFeature, RavenPoint, RavenViewport } from '../types';

export type MapFocus = { lat: number; lon: number; zoom: number; token: number } | null;

/** Below this zoom the OSM layer shows clusters only; individual cameras are not listed. */
export const OSM_LIST_ZOOM = 11;
const OSM_LIST_LIMIT = 4000;

/** What the vector tiles in view hold: the individual points, plus a total including clusters. */
export type OsmViewSummary = { features: RavenFeature[]; estimate: number };

const EMPTY_COLLECTION = { type: 'FeatureCollection' as const, features: [] };
const CLASS_LAYER: Record<OsmClass, LayerKey> = { alpr: 'alpr', speed: 'speedCameras', mapped: 'mappedCameras' };
const CLASS_HUE: Record<OsmClass, string> = { alpr: HUES.alpr, speed: HUES.mapped, mapped: HUES.mapped };

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

function selectedNodeId(selectedId: string | null): number {
  const match = selectedId?.match(/^osm-node-(\d+)$/);
  return match ? Number(match[1]) : -1;
}

export function RavenMap({
  initialView,
  features,
  selectedId,
  origin,
  layers,
  osmTilesUrl,
  osmAttribution,
  recentPoints,
  focus,
  onViewportChange,
  onSelect,
  onOsmView,
  onBasemap
}: {
  initialView: MapView;
  /** Live-catalog (and, without vector tiles, provider) cameras to draw as GeoJSON. */
  features: RavenFeature[];
  selectedId: string | null;
  origin: RavenPoint;
  layers: Record<LayerKey, boolean>;
  /** `pmtiles://…` URL of the OpenStreetMap camera tiles, or null when none are published. */
  osmTilesUrl: string | null;
  osmAttribution: string;
  /** [lon, lat] of cameras newly mapped in OSM since the previous weekly extract. */
  recentPoints: Array<[number, number]>;
  focus: MapFocus;
  onViewportChange: (viewport: RavenViewport) => void;
  /** A camera was clicked; `feature` is set for vector-tile points the app may not have listed yet. */
  onSelect: (id: string, feature?: RavenFeature) => void;
  /** The OSM cameras currently in view, read back from the rendered tiles. */
  onOsmView?: (summary: OsmViewSummary, bounds: RavenBounds) => void;
  onBasemap?: (source: Basemap['source']) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  // Overlay effects re-run once the style loads, so props set before then are not lost.
  const [ready, setReady] = useState(false);
  const [textFont, setTextFont] = useState<string[]>(['Noto Sans Bold']);
  const initialViewRef = useRef(initialView);
  const callbacks = useRef({ onViewportChange, onSelect, onOsmView, onBasemap, osmAttribution });
  callbacks.current = { onViewportChange, onSelect, onOsmView, onBasemap, osmAttribution };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let created: MapLibreMap | undefined;
    registerPmtilesProtocol();

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
        callbacks.current.onViewportChange(normalizeViewport({
          center: { lat: center.lat, lon: center.lng },
          bounds: { west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth() },
          zoom: map.getZoom()
        }));
      };

      map.on('load', () => {
        map.addSource('contacts', { type: 'geojson', data: featureCollection([], null), cluster: true, clusterRadius: 48, clusterMaxZoom: 14 });
        map.addSource('contacts-heat', { type: 'geojson', data: featureCollection([], null) });
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
            'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(24, 79, 149, 0)', 0.2, '#184f95', 0.45, '#2a78d6', 0.7, '#6da7ec', 1, '#cde2fb']
          }
        });

        map.addLayer({ id: 'rings-line', type: 'line', source: 'rings', filter: ['==', ['geometry-type'], 'LineString'], layout: { visibility: 'none' }, paint: { 'line-color': '#8b97ab', 'line-width': 1, 'line-opacity': 0.55, 'line-dasharray': [4, 3] } });
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

        map.addLayer({ id: 'recent-halo', type: 'circle', source: 'recent', layout: { visibility: 'none' }, paint: { 'circle-radius': 10, 'circle-opacity': 0, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.85 } });

        map.addLayer({
          id: 'clusters',
          type: 'circle',
          source: 'contacts',
          filter: ['has', 'point_count'],
          paint: { 'circle-color': '#141b2b', 'circle-stroke-color': HUES.media, 'circle-stroke-width': 1.5, 'circle-radius': ['step', ['get', 'point_count'], 16, 25, 20, 100, 25, 500, 31], 'circle-opacity': 0.93 }
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
          layout: { 'icon-image': ['get', 'marker'], 'icon-size': ['case', ['==', ['get', 'selected'], true], 1.3, 1], 'icon-allow-overlap': true, 'icon-ignore-placement': true }
        });

        map.on('click', 'contacts-points', event => {
          const id = event.features?.[0]?.properties?.id;
          if (id) callbacks.current.onSelect(String(id));
        });
        map.on('click', 'clusters', event => {
          const feature = event.features?.[0];
          const clusterId = Number(feature?.properties?.cluster_id);
          const coordinates = (feature?.geometry as any)?.coordinates as [number, number] | undefined;
          if (!Number.isFinite(clusterId) || !coordinates) return;
          const source = map.getSource('contacts') as any;
          Promise.resolve(source.getClusterExpansionZoom(clusterId)).then((zoom: number) => map.easeTo({ center: coordinates, zoom })).catch(() => undefined);
        });
        for (const layer of ['contacts-points', 'clusters']) {
          map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
          map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
        }
        emitViewport();
        setTextFont(basemap.textFont);
        setReady(true);
      });

      map.on('moveend', emitViewport);
      return map;
    };

    void loadBasemap().then(basemap => {
      if (cancelled) return;
      callbacks.current.onBasemap?.(basemap.source);
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

  // OpenStreetMap cameras from vector tiles: clusters per class below z14, markers above.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !osmTilesUrl) return;
    map.addSource(OSM_SOURCE, { type: 'vector', url: osmTilesUrl, attribution: callbacks.current.osmAttribution });
    const before = map.getLayer('contacts-heat') ? 'rings-line' : undefined;
    for (const cls of OSM_CLASSES) {
      map.addLayer({
        id: `osm-${cls}-heat`,
        type: 'heatmap',
        source: OSM_SOURCE,
        'source-layer': cls,
        maxzoom: 15,
        paint: {
          'heatmap-weight': ['interpolate', ['linear'], ['coalesce', ['get', 'point_count'], 1], 1, 0.3, 50, 1],
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 3, 0.6, 12, 1.4],
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 3, 14, 12, 30],
          'heatmap-opacity': 0,
          'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(24, 79, 149, 0)', 0.2, '#184f95', 0.45, '#2a78d6', 0.7, '#6da7ec', 1, '#cde2fb']
        }
      }, before);
    }
    for (const cls of OSM_CLASSES) {
      map.addLayer({
        id: `osm-${cls}-clusters`,
        type: 'circle',
        source: OSM_SOURCE,
        'source-layer': cls,
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#141b2b',
          'circle-stroke-color': CLASS_HUE[cls],
          'circle-stroke-width': 1.5,
          'circle-radius': ['step', ['get', 'point_count'], 13, 10, 16, 100, 20, 1000, 25, 5000, 31],
          'circle-opacity': 0.93
        }
      });
      map.addLayer({
        id: `osm-${cls}-count`,
        type: 'symbol',
        source: OSM_SOURCE,
        'source-layer': cls,
        filter: ['has', 'point_count'],
        layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': textFont, 'text-size': 11, 'text-allow-overlap': true },
        paint: { 'text-color': '#f3f6fb' }
      });
    }
    map.addLayer({
      id: 'osm-selected',
      type: 'circle',
      source: OSM_SOURCE,
      'source-layer': 'mapped',
      filter: ['==', ['id'], -1],
      paint: { 'circle-radius': 16, 'circle-color': '#ffffff', 'circle-opacity': 0.08, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 }
    });
    for (const cls of OSM_CLASSES) {
      map.addLayer({
        id: `osm-${cls}-points`,
        type: 'symbol',
        source: OSM_SOURCE,
        'source-layer': cls,
        filter: ['!', ['has', 'point_count']],
        layout: { 'icon-image': `marker-${cls}`, 'icon-size': ['case', ['==', ['id'], -1], 1.3, 1], 'icon-allow-overlap': true, 'icon-ignore-placement': true }
      });
      map.on('click', `osm-${cls}-points`, event => {
        const feature = event.features?.[0];
        const coordinates = (feature?.geometry as any)?.coordinates as [number, number] | undefined;
        if (!feature || feature.id === undefined || !coordinates) return;
        callbacks.current.onSelect(osmFeatureId(feature.id), osmTileFeature(feature.id, feature.properties as OsmTileProperties, coordinates[0], coordinates[1], callbacks.current.osmAttribution));
      });
      map.on('click', `osm-${cls}-clusters`, event => {
        const coordinates = (event.features?.[0]?.geometry as any)?.coordinates as [number, number] | undefined;
        if (coordinates) map.easeTo({ center: coordinates, zoom: Math.min(map.getZoom() + 2.5, 16) });
      });
      for (const layer of [`osm-${cls}-points`, `osm-${cls}-clusters`]) {
        map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
      }
    }

    // Read the rendered tiles back once the map settles, so the list matches the map.
    const report = () => {
      const zoom = map.getZoom();
      const mapBounds = map.getBounds();
      const bounds = { west: mapBounds.getWest(), south: mapBounds.getSouth(), east: mapBounds.getEast(), north: mapBounds.getNorth() };
      const seen = new Set<string | number>();
      const features: RavenFeature[] = [];
      let estimate = 0;
      for (const cls of OSM_CLASSES) {
        let rendered: GeoJSONFeature[] = [];
        try {
          rendered = map.querySourceFeatures(OSM_SOURCE, { sourceLayer: cls });
        } catch {
          continue;
        }
        for (const item of rendered) {
          const coordinates = (item.geometry as any)?.coordinates as [number, number] | undefined;
          if (!coordinates || !inBounds({ lon: coordinates[0], lat: coordinates[1] }, bounds)) continue;
          const properties = item.properties as OsmTileProperties;
          if (properties.point_count) {
            estimate += properties.point_count;
            continue;
          }
          if (item.id === undefined || seen.has(item.id)) continue;
          seen.add(item.id);
          estimate += 1;
          if (zoom >= OSM_LIST_ZOOM && features.length < OSM_LIST_LIMIT) {
            features.push(osmTileFeature(item.id, properties, coordinates[0], coordinates[1], callbacks.current.osmAttribution));
          }
        }
      }
      callbacks.current.onOsmView?.({ features, estimate }, bounds);
    };
    map.on('idle', report);
    const errors = (event: any) => {
      if (event?.sourceId === OSM_SOURCE) callbacks.current.onOsmView?.({ features: [], estimate: -1 }, { west: 0, south: 0, east: 0, north: 0 });
    };
    map.on('error', errors);

    return () => {
      map.off('idle', report);
      map.off('error', errors);
      if (!map.getStyle()) return;
      for (const layer of map.getStyle().layers) if (layer.id.startsWith('osm-')) map.removeLayer(layer.id);
      if (map.getSource(OSM_SOURCE)) map.removeSource(OSM_SOURCE);
    };
  }, [ready, osmTilesUrl, textFont]);

  // Layer switches: OSM classes are tile layers, the rest are GeoJSON sources.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const cls of OSM_CLASSES) {
      const visible = layers[CLASS_LAYER[cls]] ? 'visible' : 'none';
      for (const suffix of ['clusters', 'count', 'points']) {
        if (map.getLayer(`osm-${cls}-${suffix}`)) map.setLayoutProperty(`osm-${cls}-${suffix}`, 'visibility', visible);
      }
      if (map.getLayer(`osm-${cls}-heat`)) map.setPaintProperty(`osm-${cls}-heat`, 'heatmap-opacity', layers.heat && layers[CLASS_LAYER[cls]] ? 0.72 : 0);
    }
    map.setPaintProperty('contacts-heat', 'heatmap-opacity', layers.heat ? 0.72 : 0);
    for (const layer of ['fov-fill', 'fov-line']) map.setLayoutProperty(layer, 'visibility', layers.fov ? 'visible' : 'none');
    for (const layer of ['rings-line', 'rings-label']) map.setLayoutProperty(layer, 'visibility', layers.rings ? 'visible' : 'none');
    map.setLayoutProperty('recent-halo', 'visibility', layers.recent ? 'visible' : 'none');
  }, [ready, layers, osmTilesUrl]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const data = featureCollection(features, selectedId);
    (map.getSource('contacts') as GeoJSONSource | undefined)?.setData(data as any);
    (map.getSource('contacts-heat') as GeoJSONSource | undefined)?.setData(data as any);
    const nodeId = selectedNodeId(selectedId);
    if (map.getLayer('osm-selected')) {
      const selectedClass = features.find(feature => feature.id === selectedId);
      const cls: OsmClass = selectedClass?.cameraType === 'alpr' ? 'alpr' : selectedClass?.cameraType === 'speed' ? 'speed' : 'mapped';
      // The halo lives on one source-layer; point it at the selected camera's class.
      map.removeLayer('osm-selected');
      map.addLayer({
        id: 'osm-selected',
        type: 'circle',
        source: OSM_SOURCE,
        'source-layer': cls,
        filter: ['==', ['id'], nodeId],
        paint: { 'circle-radius': 16, 'circle-color': '#ffffff', 'circle-opacity': 0.08, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 }
      }, `osm-${OSM_CLASSES[0]}-points`);
    }
    for (const cls of OSM_CLASSES) {
      if (map.getLayer(`osm-${cls}-points`)) map.setLayoutProperty(`osm-${cls}-points`, 'icon-size', ['case', ['==', ['id'], nodeId], 1.3, 1]);
    }
  }, [ready, features, selectedId, osmTilesUrl]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource('fov') as GeoJSONSource | undefined)?.setData(layers.fov ? fovCollection(features) : EMPTY_COLLECTION);
  }, [ready, features, layers.fov]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource('rings') as GeoJSONSource | undefined)?.setData(layers.rings ? rangeRingCollection(origin) : EMPTY_COLLECTION);
  }, [ready, origin, layers.rings]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const data = {
      type: 'FeatureCollection' as const,
      features: layers.recent ? recentPoints.map(coordinates => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates } })) : []
    };
    (map.getSource('recent') as GeoJSONSource | undefined)?.setData(data);
  }, [ready, recentPoints, layers.recent]);

  useEffect(() => {
    if (!focus || !mapRef.current) return;
    // Not marked essential, so MapLibre jumps instead of flying when the user prefers reduced motion.
    mapRef.current.flyTo({ center: [focus.lon, focus.lat], zoom: focus.zoom });
  }, [focus]);

  return <div ref={containerRef} className="map-canvas" aria-label="Raven public camera map" />;
}

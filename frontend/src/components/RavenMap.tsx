import { useEffect, useRef } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import type { RavenBounds, RavenFeature, RavenViewport } from '../types';

export type MapFocus = { lat: number; lon: number; zoom: number; token: number } | null;

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
  features,
  selectedId,
  scanBounds,
  heatEnabled,
  outlineEnabled,
  focus,
  onViewportChange,
  onSelect
}: {
  features: RavenFeature[];
  selectedId: string | null;
  scanBounds?: RavenBounds;
  heatEnabled: boolean;
  outlineEnabled: boolean;
  focus: MapFocus;
  onViewportChange: (viewport: RavenViewport) => void;
  onSelect: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const onViewportRef = useRef(onViewportChange);
  const onSelectRef = useRef(onSelect);

  useEffect(() => { onViewportRef.current = onViewportChange; }, [onViewportChange]);
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      center: [-80.1918, 25.7617],
      zoom: 13.4,
      attributionControl: { compact: true },
      style: {
        version: 8,
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
      onViewportRef.current({
        center: { lat: center.lat, lon: center.lng },
        bounds: {
          west: bounds.getWest(),
          south: bounds.getSouth(),
          east: bounds.getEast(),
          north: bounds.getNorth()
        },
        zoom: map.getZoom()
      });
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
        layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 11 },
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
            ['==', ['get', 'selected'], true], '#62f2ff',
            ['==', ['get', 'mediaType'], 'stream'], '#62f2ff',
            ['==', ['get', 'mediaType'], 'snapshot'], '#65f0b5',
            ['==', ['get', 'cameraType'], 'speed'], '#ff875f',
            '#ffc857'
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
    });

    map.on('moveend', emitViewport);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const data = featureCollection(features, selectedId);
    (map.getSource('contacts') as GeoJSONSource | undefined)?.setData(data as any);
    (map.getSource('contacts-heat') as GeoJSONSource | undefined)?.setData(data as any);
  }, [features, selectedId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    (map.getSource('scan-area') as GeoJSONSource | undefined)?.setData(boundsPolygon(scanBounds) as any);
    if (map.getLayer('scan-area-line')) map.setPaintProperty('scan-area-line', 'line-opacity', outlineEnabled ? 0.7 : 0);
    if (map.getLayer('scan-area-fill')) map.setPaintProperty('scan-area-fill', 'fill-opacity', outlineEnabled ? 0.025 : 0);
  }, [scanBounds, outlineEnabled]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded() || !map.getLayer('contacts-heat')) return;
    map.setPaintProperty('contacts-heat', 'heatmap-opacity', heatEnabled ? 0.72 : 0);
  }, [heatEnabled]);

  useEffect(() => {
    if (!focus || !mapRef.current) return;
    mapRef.current.flyTo({ center: [focus.lon, focus.lat], zoom: focus.zoom, essential: true });
  }, [focus]);

  return <div ref={containerRef} className="map-canvas" aria-label="Raven public camera map" />;
}

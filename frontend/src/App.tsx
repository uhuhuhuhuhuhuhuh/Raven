import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { detectMode, scanArea, searchPlace } from './api';
import type { RavenFeature, RavenMode } from './types';

const DEFAULT_ORIGIN = { lat: 25.7617, lon: -80.1918 };
const TYPE_ORDER = ['alpr', 'fixed', 'dome', 'ptz', 'panorama', 'speed', 'unknown'] as const;

function toRad(value: number) { return value * Math.PI / 180; }
function toDeg(value: number) { return value * 180 / Math.PI; }
function distanceMeters(aLat: number, aLon: number, bLat: number, bLon: number) {
  const earth = 6371000;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earth * Math.asin(Math.sqrt(h));
}
function bearingDegrees(aLat: number, aLon: number, bLat: number, bLon: number) {
  const y = Math.sin(toRad(bLon - aLon)) * Math.cos(toRad(bLat));
  const x = Math.cos(toRad(aLat)) * Math.sin(toRad(bLat)) - Math.sin(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.cos(toRad(bLon - aLon));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
function formatRange(meters: number) { return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`; }
function typeLabel(type?: RavenFeature['cameraType']) { return (type || 'unknown').toUpperCase(); }

const demoFeatures: RavenFeature[] = [
  { id: 'demo-1', providerId: 'demo', kind: 'camera', cameraType: 'fixed', name: 'Demo Fixed Camera', lat: 25.7682, lon: -80.1971, bearing: 145, attribution: 'Demo data', fetchedAt: new Date().toISOString(), metadata: {} },
  { id: 'demo-2', providerId: 'demo', kind: 'camera', cameraType: 'dome', name: 'Demo Dome Camera', lat: 25.7569, lon: -80.1874, attribution: 'Demo data', fetchedAt: new Date().toISOString(), metadata: {} },
  { id: 'demo-3', providerId: 'demo', kind: 'camera', cameraType: 'alpr', name: 'Demo ALPR Marker', lat: 25.7633, lon: -80.1815, bearing: 270, attribution: 'Demo data', fetchedAt: new Date().toISOString(), metadata: {} }
];

export default function App() {
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [mode, setMode] = useState<RavenMode>('detecting');
  const [origin, setOrigin] = useState(DEFAULT_ORIGIN);
  const [radius, setRadius] = useState(1800);
  const [features, setFeatures] = useState<RavenFeature[]>(demoFeatures);
  const [selectedId, setSelectedId] = useState<string | null>(demoFeatures[0].id);
  const [status, setStatus] = useState('READY');
  const [query, setQuery] = useState('');
  const [scanActive, setScanActive] = useState(false);
  const [heatEnabled, setHeatEnabled] = useState(false);
  const [ringsEnabled, setRingsEnabled] = useState(true);
  const [clock, setClock] = useState(new Date());
  const [logs, setLogs] = useState<string[]>(['SYSTEM  RAVEN INITIALIZED', 'MAP     DEMO CONTACTS LOADED']);

  const enriched = useMemo(() => features.map(feature => ({
    ...feature,
    distance: distanceMeters(origin.lat, origin.lon, feature.lat, feature.lon),
    azimuth: bearingDegrees(origin.lat, origin.lon, feature.lat, feature.lon)
  })).sort((a, b) => a.distance - b.distance), [features, origin]);

  const selected = enriched.find(feature => feature.id === selectedId) || null;
  const counts = useMemo(() => {
    const result: Record<string, number> = {};
    enriched.forEach(feature => { const key = feature.cameraType || 'unknown'; result[key] = (result[key] || 0) + 1; });
    return result;
  }, [enriched]);

  useEffect(() => {
    detectMode().then(result => {
      setMode(result);
      setLogs(previous => [`MODE    ${result === 'local' ? 'LOCAL FASTAPI DETECTED' : 'STATIC GITHUB-PAGES CAPABLE'}`, ...previous]);
    });
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapContainer.current,
      center: [origin.lon, origin.lat],
      zoom: 13.4,
      attributionControl: false,
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
        layers: [
          { id: 'osm', type: 'raster', source: 'osm', paint: { 'raster-saturation': -0.85, 'raster-brightness-min': 0.12, 'raster-brightness-max': 0.48, 'raster-contrast': 0.3, 'raster-hue-rotate': 70 } }
        ]
      }
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
    map.on('load', () => {
      map.addSource('contacts', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'contacts-heat', type: 'heatmap', source: 'contacts', maxzoom: 16,
        paint: { 'heatmap-weight': 0.75, 'heatmap-intensity': 1.1, 'heatmap-radius': 28, 'heatmap-opacity': 0 }
      });
      map.addLayer({
        id: 'contacts', type: 'circle', source: 'contacts',
        paint: { 'circle-radius': ['case', ['==', ['get', 'selected'], true], 8, 5], 'circle-color': ['case', ['==', ['get', 'selected'], true], '#62f2ff', '#ffc857'], 'circle-stroke-color': '#07100d', 'circle-stroke-width': 2, 'circle-opacity': 0.95 }
      });
      map.on('click', 'contacts', event => {
        const id = event.features?.[0]?.properties?.id;
        if (id) setSelectedId(String(id));
      });
      map.on('mouseenter', 'contacts', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'contacts', () => { map.getCanvas().style.cursor = ''; });
      updateMapSources(map, features, selectedId, origin, radius, ringsEnabled, heatEnabled);
    });
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    updateMapSources(map, features, selectedId, origin, radius, ringsEnabled, heatEnabled);
  }, [features, selectedId, origin, radius, ringsEnabled, heatEnabled]);

  async function runScan() {
    if (mode === 'detecting') return;
    setStatus('SCANNING');
    setScanActive(true);
    setLogs(previous => [`SCAN    ${radius}M @ ${origin.lat.toFixed(4)}, ${origin.lon.toFixed(4)}`, ...previous].slice(0, 10));
    try {
      const result = await scanArea(mode, origin.lat, origin.lon, radius);
      setFeatures(result);
      setSelectedId(result[0]?.id || null);
      setStatus('READY');
      setLogs(previous => [`MAP     ${result.length} PUBLIC CONTACTS LOADED`, ...previous].slice(0, 10));
    } catch (error) {
      setStatus('SOURCE ERROR');
      setLogs(previous => [`ERROR   ${error instanceof Error ? error.message : 'SCAN FAILED'}`, ...previous].slice(0, 10));
    } finally {
      window.setTimeout(() => setScanActive(false), 500);
    }
  }

  async function submitSearch(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    setStatus('SEARCHING');
    try {
      const result = await searchPlace(query.trim());
      if (!result) throw new Error('No matching location');
      const next = { lat: result.lat, lon: result.lon };
      setOrigin(next);
      mapRef.current?.flyTo({ center: [next.lon, next.lat], zoom: 14 });
      setLogs(previous => [`SEARCH  ${result.label.toUpperCase().slice(0, 58)}`, ...previous].slice(0, 10));
      setStatus('READY');
    } catch (error) {
      setStatus('SOURCE ERROR');
      setLogs(previous => [`ERROR   ${error instanceof Error ? error.message : 'SEARCH FAILED'}`, ...previous].slice(0, 10));
    }
  }

  function useGps() {
    if (!navigator.geolocation) {
      setLogs(previous => ['GPS     GEOLOCATION UNAVAILABLE', ...previous].slice(0, 10));
      return;
    }
    setStatus('LOCATING');
    navigator.geolocation.getCurrentPosition(position => {
      const next = { lat: position.coords.latitude, lon: position.coords.longitude };
      setOrigin(next);
      mapRef.current?.flyTo({ center: [next.lon, next.lat], zoom: 15 });
      setStatus('READY');
      setLogs(previous => ['GPS     ORIGIN UPDATED', ...previous].slice(0, 10));
    }, () => {
      setStatus('READY');
      setLogs(previous => ['GPS     PERMISSION DENIED / UNAVAILABLE', ...previous].slice(0, 10));
    }, { enableHighAccuracy: true, timeout: 8000 });
  }

  return (
    <div className={`raven-shell ${scanActive ? 'scanning' : ''}`}>
      <header className="top-hud panel">
        <div className="brand-block"><div className="brand-mark">R</div><div><strong>RAVEN</strong><span>OPEN-DATA AWARENESS GRID</span></div></div>
        <HudMetric label="ORIGIN" value={`${origin.lat.toFixed(4)}, ${origin.lon.toFixed(4)}`} />
        <HudMetric label="GRID TIME" value={`${clock.toISOString().slice(11, 19)} UTC`} />
        <HudMetric label="RADIUS" value={formatRange(radius)} />
        <HudMetric label="CONTACTS" value={String(enriched.length).padStart(3, '0')} />
        <form className="search-box" onSubmit={submitSearch}><input value={query} onChange={e => setQuery(e.target.value)} placeholder="SEARCH CITY / ADDRESS / COORDINATES" /><button>GO</button></form>
        <div className="system-block"><span>SYSTEM</span><strong className={status.includes('ERROR') ? 'bad' : ''}>● {status}</strong><small>MODE {mode.toUpperCase()}</small></div>
      </header>

      <aside className="contact-register panel">
        <div className="panel-title"><span>CONTACT REGISTER</span><small>{enriched.length} TRACKED</small></div>
        <div className="contact-list">
          {enriched.length === 0 && <div className="empty-state">NO PUBLIC CONTACTS IN CURRENT RESULT</div>}
          {enriched.map((feature, index) => (
            <button key={feature.id} className={`contact-row ${selectedId === feature.id ? 'active' : ''}`} onClick={() => { setSelectedId(feature.id); mapRef.current?.flyTo({ center: [feature.lon, feature.lat], zoom: 16 }); }}>
              <span className="contact-index">{String(index + 1).padStart(3, '0')}</span>
              <span className="contact-main"><strong>{feature.name || 'CAMERA'}</strong><small>RNG {formatRange(feature.distance)} · AZ {Math.round(feature.azimuth)}°</small></span>
              <span className="contact-tag">{typeLabel(feature.cameraType)}</span>
            </button>
          ))}
        </div>
      </aside>

      <main className="map-stage">
        <div ref={mapContainer} className="map-canvas" />
        <div className="map-grid-overlay" />
        <div className="origin-reticle" aria-hidden="true"><span /><span /></div>
        {scanActive && <div className="scan-sweep" />}
        {selected && (
          <section className="detail-card panel">
            <div className="panel-title"><span>CONTACT DETAIL</span><button onClick={() => setSelectedId(null)}>×</button></div>
            <strong className="detail-name">{selected.name}</strong>
            <dl>
              <div><dt>TYPE</dt><dd>{typeLabel(selected.cameraType)}</dd></div>
              <div><dt>RANGE</dt><dd>{formatRange(selected.distance)}</dd></div>
              <div><dt>AZIMUTH</dt><dd>{Math.round(selected.azimuth)}°</dd></div>
              <div><dt>COORD</dt><dd>{selected.lat.toFixed(6)}, {selected.lon.toFixed(6)}</dd></div>
              <div><dt>DIRECTION</dt><dd>{selected.bearing === undefined ? 'UNKNOWN' : `${selected.bearing}°`}</dd></div>
              <div><dt>OPERATOR</dt><dd>{selected.operator || 'UNSPECIFIED'}</dd></div>
            </dl>
            <div className="detail-source">{selected.attribution || selected.providerId}</div>
            {selected.sourceUrl && <a href={selected.sourceUrl} target="_blank" rel="noreferrer">OPEN PUBLIC SOURCE ↗</a>}
          </section>
        )}
      </main>

      <aside className="analytics-rail panel">
        <MetricCard label="DETECTED / LOADED" value={String(enriched.length)} sub={features.some(feature => feature.providerId === 'demo') ? 'DEMO UNTIL SCAN' : 'CURRENT RESULT'} />
        <section className="analytics-card"><div className="section-label">CLASSIFICATION</div>{TYPE_ORDER.filter(type => counts[type]).map(type => <ClassBar key={type} label={type.toUpperCase()} value={counts[type] || 0} total={Math.max(enriched.length, 1)} />)}</section>
        <MetricCard label="NEAREST" value={enriched[0] ? formatRange(enriched[0].distance) : '—'} sub={enriched[0] ? typeLabel(enriched[0].cameraType) : 'NO CONTACT'} />
        <section className="analytics-card"><div className="section-label">DATA HEALTH</div><div className="health-line"><span>MODE</span><strong>{mode.toUpperCase()}</strong></div><div className="health-line"><span>PROVIDER</span><strong>OSM / OVERPASS</strong></div><div className="health-line"><span>STATE</span><strong>{status}</strong></div></section>
      </aside>

      <section className="system-log panel">
        <div className="panel-title"><span>SYSTEM LOG</span><small>SESSION</small></div>
        <div className="log-lines">{logs.map((line, index) => <div key={`${line}-${index}`}><span>{new Date(Date.now() - index * 1000).toISOString().slice(11, 19)}</span>{line}</div>)}</div>
      </section>

      <footer className="command-bar panel">
        <button className="command primary" onClick={runScan}>SCAN AREA</button>
        <button className="command" onClick={useGps}>GPS</button>
        <button className={`command ${ringsEnabled ? 'on' : ''}`} onClick={() => setRingsEnabled(value => !value)}>RINGS</button>
        <button className={`command ${heatEnabled ? 'on' : ''}`} onClick={() => setHeatEnabled(value => !value)}>HEAT</button>
        <label className="radius-control"><span>SCAN RADIUS</span><input type="range" min="250" max="10000" step="250" value={radius} onChange={e => setRadius(Number(e.target.value))} /><strong>{formatRange(radius)}</strong></label>
        <div className="command-note">PUBLIC / OPEN DATA ONLY</div>
      </footer>
    </div>
  );
}

function HudMetric({ label, value }: { label: string; value: string }) {
  return <div className="hud-metric"><span>{label}</span><strong>{value}</strong></div>;
}
function MetricCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return <section className="analytics-card metric-card"><div className="section-label">{label}</div><strong>{value}</strong><small>{sub}</small></section>;
}
function ClassBar({ label, value, total }: { label: string; value: number; total: number }) {
  return <div className="class-bar"><div><span>{label}</span><strong>{value}</strong></div><div className="bar-track"><span style={{ width: `${Math.max(6, value / total * 100)}%` }} /></div></div>;
}

function updateMapSources(map: MapLibreMap, features: RavenFeature[], selectedId: string | null, origin: { lat: number; lon: number }, radius: number, ringsEnabled: boolean, heatEnabled: boolean) {
  const source = map.getSource('contacts') as GeoJSONSource | undefined;
  if (source) {
    source.setData({
      type: 'FeatureCollection',
      features: features.map(feature => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [feature.lon, feature.lat] },
        properties: { id: feature.id, selected: feature.id === selectedId, type: feature.cameraType || 'unknown' }
      }))
    });
  }
  if (map.getLayer('contacts-heat')) map.setPaintProperty('contacts-heat', 'heatmap-opacity', heatEnabled ? 0.72 : 0);

  const ringId = 'scan-ring';
  const ringSourceId = 'scan-ring-source';
  const ringData = circleGeoJson(origin.lon, origin.lat, radius);
  const ringSource = map.getSource(ringSourceId) as GeoJSONSource | undefined;
  if (ringSource) ringSource.setData(ringData);
  else if (map.isStyleLoaded()) {
    map.addSource(ringSourceId, { type: 'geojson', data: ringData });
    map.addLayer({ id: ringId, type: 'line', source: ringSourceId, paint: { 'line-color': '#5ef0b7', 'line-width': 1.25, 'line-opacity': ringsEnabled ? 0.7 : 0, 'line-dasharray': [2, 2] } });
  }
  if (map.getLayer(ringId)) map.setPaintProperty(ringId, 'line-opacity', ringsEnabled ? 0.7 : 0);
}

function circleGeoJson(lon: number, lat: number, radiusMeters: number): any {
  const points: [number, number][] = [];
  const steps = 96;
  const earth = 6378137;
  const angular = radiusMeters / earth;
  const latRad = toRad(lat);
  const lonRad = toRad(lon);
  for (let i = 0; i <= steps; i++) {
    const bearing = 2 * Math.PI * i / steps;
    const pointLat = Math.asin(Math.sin(latRad) * Math.cos(angular) + Math.cos(latRad) * Math.sin(angular) * Math.cos(bearing));
    const pointLon = lonRad + Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(latRad), Math.cos(angular) - Math.sin(latRad) * Math.sin(pointLat));
    points.push([toDeg(pointLon), toDeg(pointLat)]);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [points] } };
}

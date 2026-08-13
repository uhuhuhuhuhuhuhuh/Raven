import { FormEvent, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { clearProviderCache, getCachedProviderScan, putCachedProviderScan } from './cache';
import { CameraViewer } from './components/CameraViewer';
import { LayerPanel } from './components/LayerPanel';
import { RavenMap, type MapFocus } from './components/RavenMap';
import { VirtualContactList, type EnrichedFeature } from './components/VirtualContactList';
import { providerById, providerPlan, ravenProviders } from './providers/registry';
import { searchPlace } from './search';
import { allFeatures, createInitialState, hasSnapshot, hasStream, logEntry, ravenReducer, visibleFeatures } from './state';
import type { LayerKey, RavenFeature, RavenMode, RavenViewport } from './types';

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
function typeLabel(feature: RavenFeature) {
  if (hasStream(feature)) return 'STREAM';
  if (hasSnapshot(feature)) return 'SNAPSHOT';
  if (feature.mediaType === 'external') return 'EXTERNAL';
  return (feature.cameraType || 'unknown').toUpperCase();
}
function scanId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function abortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function detectMode(): Promise<RavenMode> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 1100);
  try {
    const response = await fetch(`${window.location.origin}/api/health`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) return 'static';
    const payload = await response.json();
    return payload?.service === 'raven' ? 'local' : 'static';
  } catch {
    return 'static';
  } finally {
    clearTimeout(timer);
  }
}

export default function App() {
  const [state, dispatch] = useReducer(ravenReducer, undefined, createInitialState);
  const [clock, setClock] = useState(new Date());
  const [query, setQuery] = useState('');
  const [activity, setActivity] = useState('READY');
  const [focus, setFocus] = useState<MapFocus>(null);
  const [mobilePanel, setMobilePanel] = useState<'none' | 'contacts' | 'layers' | 'log'>('none');
  const scanControllerRef = useRef<AbortController | null>(null);
  const searchControllerRef = useRef<AbortController | null>(null);

  const fetched = useMemo(() => allFeatures(state), [state.providers]);
  const visible = useMemo(() => visibleFeatures(state), [state.providers, state.layers]);
  const enriched = useMemo<EnrichedFeature[]>(() => visible.map(feature => ({
    ...feature,
    distance: distanceMeters(state.referenceOrigin.lat, state.referenceOrigin.lon, feature.lat, feature.lon),
    azimuth: bearingDegrees(state.referenceOrigin.lat, state.referenceOrigin.lon, feature.lat, feature.lon)
  })).sort((a, b) => a.distance - b.distance), [visible, state.referenceOrigin]);
  const selected = enriched.find(feature => feature.id === state.selectionId) || null;

  const mediaCounts = useMemo(() => ({
    snapshot: visible.filter(hasSnapshot).length,
    stream: visible.filter(hasStream).length,
    mapped: visible.filter(feature => !hasSnapshot(feature) && !hasStream(feature)).length,
    speed: visible.filter(feature => feature.cameraType === 'speed').length
  }), [visible]);

  const addLog = useCallback((channel: string, message: string, level: 'info' | 'warn' | 'error' = 'info') => {
    dispatch({ type: 'LOG', entry: logEntry(channel, message, level) });
  }, []);

  useEffect(() => {
    detectMode().then(mode => {
      dispatch({ type: 'MODE_SET', mode });
      addLog('MODE', mode === 'local' ? 'LOCAL FASTAPI DETECTED' : 'STATIC GITHUB PAGES MODE');
    });
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => {
      window.clearInterval(timer);
      scanControllerRef.current?.abort();
      searchControllerRef.current?.abort();
    };
  }, [addLog]);

  useEffect(() => {
    if (state.selectionId && !visible.some(feature => feature.id === state.selectionId)) {
      dispatch({ type: 'SELECT', id: null });
    }
  }, [state.selectionId, visible]);

  const runScan = useCallback(async (reason: 'manual' | 'auto' = 'manual') => {
    if (state.mode === 'detecting') return;
    scanControllerRef.current?.abort();
    const controller = new AbortController();
    scanControllerRef.current = controller;
    const id = scanId();
    const plan = providerPlan(state.viewport.bounds, state.viewport.zoom);
    const activeIds = plan.active.map(provider => provider.id);
    const allIds = ravenProviders.map(provider => provider.id);
    const startedAt = Date.now();

    dispatch({
      type: 'SCAN_BEGIN',
      id,
      bounds: state.viewport.bounds,
      center: state.viewport.center,
      activeProviderIds: activeIds,
      allProviderIds: allIds,
      skipReasons: plan.skipped,
      timestamp: startedAt
    });
    setActivity('SCANNING');
    addLog('SCAN', `${reason.toUpperCase()} · ${activeIds.join(' + ') || 'NO ELIGIBLE PROVIDERS'} · z${state.viewport.zoom.toFixed(1)}`);

    const results = await Promise.all(plan.active.map(async provider => {
      let cachedFeatures: RavenFeature[] | null = null;
      let cachedPages: number | undefined;
      const cacheTtl = provider.cacheTtlMs ?? 5 * 60 * 1000;

      try {
        const cached = await getCachedProviderScan(provider.id, state.viewport.bounds, cacheTtl);
        if (cached && !controller.signal.aborted && scanControllerRef.current === controller) {
          cachedFeatures = cached.features;
          cachedPages = cached.pages;
          dispatch({
            type: 'PROVIDER_PROGRESS',
            scanId: id,
            providerId: provider.id,
            features: cached.features,
            progress: { completed: 0, total: 1 },
            pages: cached.pages,
            fromCache: true,
            timestamp: Date.now()
          });
          addLog(provider.id.toUpperCase(), `${cached.features.length} CONTACTS RESTORED FROM CACHE`);
        }
      } catch {
        // Cache is an optimization. Network scanning continues normally.
      }

      try {
        const result = await provider.scan({
          mode: state.mode,
          bounds: state.viewport.bounds,
          zoom: state.viewport.zoom,
          onProgress: (features, progress) => {
            if (controller.signal.aborted || scanControllerRef.current !== controller) return;
            dispatch({
              type: 'PROVIDER_PROGRESS',
              scanId: id,
              providerId: provider.id,
              features,
              progress,
              pages: progress.completed,
              timestamp: Date.now()
            });
          }
        }, controller.signal);
        if (controller.signal.aborted || scanControllerRef.current !== controller) return { providerId: provider.id, status: 'aborted' as const };
        dispatch({
          type: 'PROVIDER_SUCCESS',
          scanId: id,
          providerId: provider.id,
          features: result.features,
          pages: result.pages,
          timestamp: Date.now()
        });
        void putCachedProviderScan(provider.id, state.viewport.bounds, result.features, result.pages);
        addLog(provider.id.toUpperCase(), `${result.features.length} CONTACTS${result.pages && result.pages > 1 ? ` · ${result.pages} TILES/PAGES` : ''}`);
        return { providerId: provider.id, status: 'ready' as const, count: result.features.length };
      } catch (error) {
        if (controller.signal.aborted || abortError(error)) return { providerId: provider.id, status: 'aborted' as const };
        const message = error instanceof Error ? error.message : 'Provider scan failed';
        if (cachedFeatures) {
          dispatch({
            type: 'PROVIDER_SUCCESS',
            scanId: id,
            providerId: provider.id,
            features: cachedFeatures,
            pages: cachedPages,
            warning: `NETWORK REFRESH FAILED · CACHED DATA SHOWN · ${message}`,
            fromCache: true,
            timestamp: Date.now()
          });
          addLog(provider.id.toUpperCase(), `NETWORK FAILED · USING CACHED DATA · ${message}`, 'warn');
          return { providerId: provider.id, status: 'cached' as const };
        }
        dispatch({ type: 'PROVIDER_ERROR', scanId: id, providerId: provider.id, error: message, timestamp: Date.now() });
        addLog(provider.id.toUpperCase(), message, 'error');
        return { providerId: provider.id, status: 'error' as const };
      }
    }));

    if (controller.signal.aborted || scanControllerRef.current !== controller) return;
    const usable = results.filter(result => result.status === 'ready' || result.status === 'cached').length;
    const degraded = results.filter(result => result.status === 'error' || result.status === 'cached').length;
    const finalStatus = usable === 0 && degraded > 0 ? 'error' : degraded > 0 ? 'partial' : 'ready';
    dispatch({ type: 'SCAN_FINISH', scanId: id, status: finalStatus, timestamp: Date.now() });
    setActivity('READY');
    addLog('SCAN', finalStatus === 'partial' ? 'COMPLETE WITH DEGRADED PROVIDERS' : finalStatus === 'error' ? 'FAILED' : 'COMPLETE', finalStatus === 'error' ? 'error' : finalStatus === 'partial' ? 'warn' : 'info');
  }, [state.mode, state.viewport.bounds, state.viewport.center, state.viewport.zoom, addLog]);

  useEffect(() => {
    if (!state.autoScan || state.mode === 'detecting' || state.scan.status !== 'dirty') return;
    const timer = window.setTimeout(() => void runScan('auto'), 800);
    return () => window.clearTimeout(timer);
  }, [state.autoScan, state.mode, state.scan.status, state.viewport.bounds, runScan]);

  const handleViewport = useCallback((viewport: RavenViewport) => {
    dispatch({ type: 'VIEWPORT_CHANGED', viewport });
  }, []);

  async function submitSearch(event: FormEvent) {
    event.preventDefault();
    if (!query.trim() || state.mode === 'detecting') return;
    searchControllerRef.current?.abort();
    const controller = new AbortController();
    searchControllerRef.current = controller;
    setActivity('SEARCHING');
    try {
      const result = await searchPlace(state.mode, query.trim(), controller.signal);
      if (!result) throw new Error('No matching location');
      addLog('SEARCH', result.label.toUpperCase().slice(0, 72));
      setFocus({ lat: result.lat, lon: result.lon, zoom: 14, token: Date.now() });
    } catch (error) {
      if (!abortError(error)) addLog('SEARCH', error instanceof Error ? error.message : 'Search failed', 'error');
    } finally {
      if (!controller.signal.aborted) setActivity('READY');
    }
  }

  function useGps() {
    if (!navigator.geolocation) {
      addLog('GPS', 'GEOLOCATION UNAVAILABLE', 'error');
      return;
    }
    setActivity('LOCATING');
    navigator.geolocation.getCurrentPosition(position => {
      const point = { lat: position.coords.latitude, lon: position.coords.longitude };
      dispatch({ type: 'REFERENCE_ORIGIN_SET', point, source: 'gps' });
      setFocus({ ...point, zoom: 15, token: Date.now() });
      addLog('GPS', 'REFERENCE ORIGIN UPDATED');
      setActivity('READY');
    }, error => {
      addLog('GPS', error.message || 'PERMISSION DENIED / UNAVAILABLE', 'error');
      setActivity('READY');
    }, { enableHighAccuracy: true, timeout: 8000 });
  }

  function useScanOrigin() {
    const point = state.scan.center || state.viewport.center;
    dispatch({ type: 'REFERENCE_ORIGIN_SET', point, source: 'scan' });
    addLog('ORIGIN', 'DISTANCE / AZIMUTH REFERENCE SET TO SCAN CENTER');
  }

  function toggleLayer(layer: LayerKey) {
    dispatch({ type: 'LAYER_TOGGLE', layer });
    addLog('LAYER', `${layer.toUpperCase()} TOGGLED`);
  }

  async function clearCache() {
    await clearProviderCache();
    addLog('CACHE', 'BROWSER PROVIDER CACHE CLEARED');
  }

  const statusLabel = activity !== 'READY' ? activity : ({
    idle: 'READY TO SCAN',
    dirty: 'RESULTS STALE',
    scanning: 'SCANNING',
    partial: 'PARTIAL',
    ready: 'READY',
    error: 'SOURCE ERROR'
  } as const)[state.scan.status];

  const statusBad = state.scan.status === 'error';
  const statusWarn = state.scan.status === 'dirty' || state.scan.status === 'partial';

  return (
    <div className={`raven-shell scan-${state.scan.status}`}>
      <header className="top-hud panel">
        <div className="brand-block"><div className="brand-mark">R</div><div><strong>RAVEN</strong><span>OPEN-DATA AWARENESS GRID</span></div></div>
        <HudMetric label="REFERENCE ORIGIN" value={`${state.referenceOrigin.lat.toFixed(4)}, ${state.referenceOrigin.lon.toFixed(4)}`} sub={state.referenceOrigin.source.toUpperCase()} />
        <HudMetric label="GRID TIME" value={`${clock.toISOString().slice(11, 19)} UTC`} />
        <HudMetric label="VIEW" value={`z${state.viewport.zoom.toFixed(1)}`} sub={state.scan.status === 'dirty' ? 'STALE' : 'SYNC'} />
        <HudMetric label="VISIBLE" value={String(enriched.length).padStart(4, '0')} sub={`${fetched.length} FETCHED`} />
        <form className="search-box" onSubmit={submitSearch}><input aria-label="Search city, address, or coordinates" value={query} onChange={event => setQuery(event.target.value)} placeholder="SEARCH CITY / ADDRESS / LAT,LON" /><button type="submit">GO</button></form>
        <div className="system-block"><span>SYSTEM</span><strong className={statusBad ? 'bad' : statusWarn ? 'warn' : ''}>● {statusLabel}</strong><small>MODE {state.mode.toUpperCase()}</small></div>
      </header>

      <aside className={`contact-register panel ${mobilePanel === 'contacts' ? 'mobile-open' : ''}`}>
        <div className="panel-title"><span>CONTACT REGISTER</span><small>{enriched.length} VISIBLE</small><button className="mobile-close" onClick={() => setMobilePanel('none')}>×</button></div>
        <VirtualContactList features={enriched} selectedId={state.selectionId} onSelect={id => dispatch({ type: 'SELECT', id })} />
      </aside>

      <main className="map-stage">
        <RavenMap
          features={visible}
          selectedId={state.selectionId}
          scanBounds={state.scan.bounds}
          heatEnabled={state.layers.heat}
          outlineEnabled={state.layers.scanOutline}
          focus={focus}
          onViewportChange={handleViewport}
          onSelect={id => dispatch({ type: 'SELECT', id })}
        />
        <div className="map-grid-overlay" />
        <div className="origin-reticle" aria-hidden="true"><span /><span /></div>
        {state.scan.status === 'scanning' && <div className="scan-sweep" />}
        {state.scan.status === 'dirty' && <div className="stale-banner">VIEWPORT CHANGED · RESULTS ARE FROM THE PREVIOUS SCAN <button onClick={() => void runScan('manual')}>RESCAN</button></div>}
        {selected && (
          <section className="detail-card panel">
            <div className="panel-title"><span>CONTACT DETAIL</span><button onClick={() => dispatch({ type: 'SELECT', id: null })}>×</button></div>
            <strong className="detail-name">{selected.name || 'CAMERA'}</strong>
            <CameraViewer feature={selected} />
            <dl>
              <div><dt>CLASS</dt><dd>{typeLabel(selected)}</dd></div>
              <div><dt>RANGE</dt><dd>{formatRange(selected.distance)}</dd></div>
              <div><dt>AZIMUTH</dt><dd>{Math.round(selected.azimuth)}°</dd></div>
              <div><dt>COORD</dt><dd>{selected.lat.toFixed(6)}, {selected.lon.toFixed(6)}</dd></div>
              <div><dt>DIRECTION</dt><dd>{selected.directionLabel || (selected.bearing === undefined ? 'UNKNOWN' : `${selected.bearing}°`)}</dd></div>
              <div><dt>OPERATOR</dt><dd>{selected.operator || 'UNSPECIFIED'}</dd></div>
              <div><dt>PROVIDER</dt><dd>{providerById(selected.providerId)?.name || selected.providerId}</dd></div>
              {selected.sourceUpdatedAt && <div><dt>SOURCE UPDATE</dt><dd>{selected.sourceUpdatedAt}</dd></div>}
            </dl>
            <details className="debug-details"><summary>PROVIDER / RAW METADATA</summary><pre>{JSON.stringify(selected.metadata, null, 2)}</pre></details>
            <div className="detail-source">{selected.attribution || selected.providerId}</div>
            {selected.sourceUrl && <a href={selected.sourceUrl} target="_blank" rel="noreferrer">OPEN OFFICIAL / PUBLIC SOURCE ↗</a>}
          </section>
        )}
      </main>

      <aside className={`analytics-rail panel ${mobilePanel === 'layers' ? 'mobile-open' : ''}`}>
        <div className="mobile-panel-head"><span>ANALYTICS / LAYERS</span><button onClick={() => setMobilePanel('none')}>×</button></div>
        <MetricCard label="VISIBLE CONTACTS" value={String(enriched.length)} sub={`${fetched.length} FETCHED`} />
        <section className="analytics-card classification-grid">
          <div className="section-label">MEDIA / CLASSIFICATION</div>
          <ClassCount label="MAPPED" value={mediaCounts.mapped} />
          <ClassCount label="SNAPSHOT" value={mediaCounts.snapshot} />
          <ClassCount label="STREAM" value={mediaCounts.stream} />
          <ClassCount label="SPEED" value={mediaCounts.speed} />
        </section>
        <MetricCard label="NEAREST" value={enriched[0] ? formatRange(enriched[0].distance) : '—'} sub={enriched[0] ? typeLabel(enriched[0]) : 'NO VISIBLE CONTACT'} />
        <section className="analytics-card provider-health">
          <div className="section-label">PROVIDER HEALTH</div>
          {ravenProviders.map(provider => {
            const run = state.providers[provider.id];
            const label = run?.status || 'idle';
            const progress = run?.progress ? ` · ${run.progress.completed}/${run.progress.total}` : '';
            return <div className={`health-line status-${label}`} key={provider.id}>
              <span>{provider.name}</span>
              <strong>{label.toUpperCase()}{run?.features.length ? ` · ${run.features.length}` : ''}{progress}{run?.fromCache ? ' · CACHE' : ''}</strong>
              {run?.skipReason && <small>{run.skipReason}</small>}
              {run?.warning && <small className="warning-text">{run.warning}</small>}
              {run?.error && <small>{run.error}</small>}
            </div>;
          })}
        </section>
        <LayerPanel
          layers={state.layers}
          autoScan={state.autoScan}
          onToggle={toggleLayer}
          onAutoScan={value => { dispatch({ type: 'AUTO_SCAN_SET', value }); addLog('SCAN', `AUTO SCAN ${value ? 'ENABLED' : 'DISABLED'}`); }}
        />
      </aside>

      <section className={`system-log panel ${mobilePanel === 'log' ? 'mobile-open' : ''}`}>
        <div className="panel-title"><span>SYSTEM LOG</span><small>{state.logs.length} EVENTS</small><button className="mobile-close" onClick={() => setMobilePanel('none')}>×</button></div>
        <div className="log-lines">{state.logs.map(entry => <div key={entry.id} className={`log-${entry.level}`}><span>{new Date(entry.timestamp).toISOString().slice(11, 19)}</span><b>{entry.channel.padEnd(8, ' ')}</b>{entry.message}</div>)}</div>
      </section>

      <footer className="command-bar panel">
        <button className="command primary" disabled={state.mode === 'detecting' || state.scan.status === 'scanning'} onClick={() => void runScan('manual')}>SCAN VIEW</button>
        <button className="command" onClick={useGps}>GPS ORIGIN</button>
        <button className="command" onClick={useScanOrigin}>SCAN ORIGIN</button>
        <button className={`command ${state.autoScan ? 'on' : ''}`} aria-pressed={state.autoScan} onClick={() => dispatch({ type: 'AUTO_SCAN_SET', value: !state.autoScan })}>AUTO SCAN</button>
        <button className="command" onClick={() => void clearCache()}>CLEAR CACHE</button>
        <div className="scan-readout"><span>SCAN MODEL</span><strong>VISIBLE BOUNDS · SAFE TILES · z{state.viewport.zoom.toFixed(1)}</strong></div>
        <div className="command-note">PUBLIC / OPEN DATA ONLY · © OPENSTREETMAP CONTRIBUTORS · FL511 / FDOT · CALTRANS</div>
      </footer>

      <nav className="mobile-toolbar" aria-label="Raven mobile panels">
        <button onClick={() => setMobilePanel('contacts')}>CONTACTS</button>
        <button onClick={() => setMobilePanel('layers')}>LAYERS</button>
        <button onClick={() => setMobilePanel('log')}>LOG</button>
        <button onClick={() => void runScan('manual')}>SCAN</button>
      </nav>
    </div>
  );
}

function HudMetric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="hud-metric"><span>{label}</span><strong>{value}</strong>{sub && <small>{sub}</small>}</div>;
}
function MetricCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return <section className="analytics-card metric-card"><div className="section-label">{label}</div><strong>{value}</strong><small>{sub}</small></section>;
}
function ClassCount({ label, value }: { label: string; value: number }) {
  return <div className="class-count"><span>{label}</span><strong>{value}</strong></div>;
}

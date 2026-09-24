import { FormEvent, useCallback, useEffect, useMemo, useReducer, useRef, useState, type ComponentType } from 'react';
import {
  Activity,
  ArrowRight,
  Crosshair,
  Database,
  Download,
  Eye,
  ExternalLink,
  Filter,
  Layers,
  List,
  LocateFixed,
  MapPinPlus,
  PencilLine,
  Radar,
  RefreshCw,
  Rss,
  Search,
  Target,
  TerminalSquare,
  Trash2,
  X
} from 'lucide-react';
import { clearProviderCache, getCachedProviderScan, putCachedProviderScan } from './cache';
import { CameraViewer } from './components/CameraViewer';
import { LayerPanel } from './components/LayerPanel';
import { MarkerSwatch } from './components/MarkerSwatch';
import { RavenMap, type MapFocus } from './components/RavenMap';
import { VirtualContactList, type EnrichedFeature } from './components/VirtualContactList';
import { downloadGeoJson, featuresToGeoJson } from './exportGeoJson';
import { matchesFilter } from './filter';
import { bearingDegrees, distanceMeters, formatRange } from './geo';
import { MARKER_BY_KEY, MARKER_CLASSES, markerKey, type MarkerKey } from './markers';
import { abortError } from './net';
import { osmAddUrl, osmEditUrl } from './osmLinks';
import { formatViewHash, parseViewHash } from './permalink';
import { loadPreferences, savePreferences } from './preferences';
import { loadOsmChanges, type OsmChanges } from './providers/osmTiles';
import { providerById, providerPlan, ravenProviders } from './providers/registry';
import { searchPlace } from './search';
import {
  allFeatures,
  createInitialState,
  DEFAULT_VIEW,
  LAYER_KEYS,
  logEntry,
  ravenReducer,
  visibleFeatures
} from './state';
import type { LayerKey, ProviderRun, RavenFeature, RavenLogEntry, RavenMode, RavenViewport } from './types';

// Raven's static API (camera catalog, OSM extract tiles) sits beside the app on Pages and in Raven Local.
const STATIC_API_BASE = new URL('api/v1/', document.baseURI).href;

function scanId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
  // A shared #map=zoom/lat/lon link opens on that view; saved layer choices are restored.
  const [initialView] = useState(() => parseViewHash(window.location.hash) ?? DEFAULT_VIEW);
  const [state, dispatch] = useReducer(ravenReducer, undefined, () => {
    const saved = loadPreferences(LAYER_KEYS);
    return createInitialState(initialView, saved.layers, saved.autoScan);
  });
  const [clock, setClock] = useState(new Date());
  const [query, setQuery] = useState('');
  const [registerFilter, setRegisterFilter] = useState('');
  const [osmChanges, setOsmChanges] = useState<OsmChanges | null>(null);
  const [activity, setActivity] = useState('READY');
  const [focus, setFocus] = useState<MapFocus>(null);
  const [mobilePanel, setMobilePanel] = useState<'none' | 'contacts' | 'side'>('none');
  const [sideTab, setSideTab] = useState<SideTab>('overview');
  // Scans wait for the map's first real viewport; before that the bounds are a placeholder.
  const [mapReady, setMapReady] = useState(false);
  const scanControllerRef = useRef<AbortController | null>(null);
  const searchControllerRef = useRef<AbortController | null>(null);

  const fetched = useMemo(() => allFeatures(state), [state]);
  const visible = useMemo(() => visibleFeatures(state), [state]);
  const enriched = useMemo<EnrichedFeature[]>(() => visible.map(feature => ({
    ...feature,
    distance: distanceMeters(state.referenceOrigin.lat, state.referenceOrigin.lon, feature.lat, feature.lon),
    azimuth: bearingDegrees(state.referenceOrigin.lat, state.referenceOrigin.lon, feature.lat, feature.lon)
  })).sort((a, b) => a.distance - b.distance), [visible, state.referenceOrigin]);
  const selected = enriched.find(feature => feature.id === state.selectionId) || null;
  const recentPoints = useMemo(() => osmChanges?.added.map(([, lat, lon]) => [lon, lat] as [number, number]) ?? [], [osmChanges]);
  const registerFeatures = useMemo(
    () => (registerFilter.trim() ? enriched.filter(feature => matchesFilter(feature, registerFilter)) : enriched),
    [enriched, registerFilter]
  );

  const classCounts = useMemo(() => {
    const counts: Record<MarkerKey, number> = { stream: 0, snapshot: 0, alpr: 0, speed: 0, mapped: 0 };
    for (const feature of visible) counts[markerKey(feature)] += 1;
    return counts;
  }, [visible]);
  const facingCount = useMemo(() => visible.filter(feature => feature.bearing !== undefined).length, [visible]);

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

  // Weekly extract changes, when the deploy published them.
  useEffect(() => {
    let active = true;
    void loadOsmChanges(STATIC_API_BASE).then(changes => {
      if (!active || !changes) return;
      setOsmChanges(changes);
      addLog('OSM', `${changes.addedCount} CAMERAS NEWLY MAPPED SINCE ${changes.since?.slice(0, 10) ?? 'THE LAST EXTRACT'}`);
    });
    return () => { active = false; };
  }, [addLog]);

  useEffect(() => {
    savePreferences({ layers: state.layers, autoScan: state.autoScan });
  }, [state.layers, state.autoScan]);

  // Keep the address bar pointing at the current view so it can be bookmarked or shared.
  useEffect(() => {
    const hash = formatViewHash({ ...state.viewport.center, zoom: state.viewport.zoom });
    if (window.location.hash !== hash) window.history.replaceState(window.history.state, '', hash);
  }, [state.viewport]);

  useEffect(() => {
    const onHashChange = () => {
      const view = parseViewHash(window.location.hash);
      if (view) setFocus({ ...view, token: Date.now() });
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (event.target instanceof HTMLElement && event.target.closest('input, select, textarea')) return;
      if (mobilePanel !== 'none') setMobilePanel('none');
      else if (state.selectionId) dispatch({ type: 'SELECT', id: null });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobilePanel, state.selectionId]);

  useEffect(() => {
    if (state.selectionId && !visible.some(feature => feature.id === state.selectionId)) {
      dispatch({ type: 'SELECT', id: null });
    }
  }, [state.selectionId, visible]);

  const runScan = useCallback(async (reason: 'manual' | 'auto' = 'manual') => {
    if (state.mode === 'detecting' || !mapReady) return;
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
      let progressFeatures: RavenFeature[] = [];
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
          staticApiBase: STATIC_API_BASE,
          onProgress: (features, progress) => {
            if (controller.signal.aborted || scanControllerRef.current !== controller) return;
            progressFeatures = features;
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
          warning: result.warning,
          timestamp: Date.now()
        });
        // Only complete results are cached, so a later restore never passes off a partial scan as whole.
        if (!result.warning) void putCachedProviderScan(provider.id, state.viewport.bounds, result.features, result.pages);
        const summary = `${result.features.length} CONTACTS${result.pages && result.pages > 1 ? ` · ${result.pages} TILES/PAGES` : ''}`;
        addLog(provider.id.toUpperCase(), result.warning ? `${summary} · ${result.warning}` : summary, result.warning ? 'warn' : 'info');
        return { providerId: provider.id, status: result.warning ? 'incomplete' as const : 'ready' as const, count: result.features.length };
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
        // Keep whatever already streamed in rather than clearing contacts the user is looking at.
        dispatch({ type: 'PROVIDER_ERROR', scanId: id, providerId: provider.id, error: message, features: progressFeatures, timestamp: Date.now() });
        addLog(provider.id.toUpperCase(), progressFeatures.length ? `${message} · KEPT ${progressFeatures.length} PARTIAL CONTACTS` : message, 'error');
        return { providerId: provider.id, status: progressFeatures.length ? 'incomplete' as const : 'error' as const };
      }
    }));

    if (controller.signal.aborted || scanControllerRef.current !== controller) return;
    const usable = results.filter(result => result.status === 'ready' || result.status === 'cached' || result.status === 'incomplete').length;
    const degraded = results.filter(result => result.status === 'error' || result.status === 'cached' || result.status === 'incomplete').length;
    const finalStatus = usable === 0 && degraded > 0 ? 'error' : degraded > 0 ? 'partial' : 'ready';
    dispatch({ type: 'SCAN_FINISH', scanId: id, status: finalStatus, timestamp: Date.now() });
    setActivity('READY');
    addLog('SCAN', finalStatus === 'partial' ? 'COMPLETE WITH DEGRADED PROVIDERS' : finalStatus === 'error' ? 'FAILED' : 'COMPLETE', finalStatus === 'error' ? 'error' : finalStatus === 'partial' ? 'warn' : 'info');
  }, [state.mode, mapReady, state.viewport.bounds, state.viewport.center, state.viewport.zoom, addLog]);

  useEffect(() => {
    if (!state.autoScan || state.mode === 'detecting' || state.scan.status !== 'dirty') return;
    const timer = window.setTimeout(() => void runScan('auto'), 800);
    return () => window.clearTimeout(timer);
  }, [state.autoScan, state.mode, state.scan.status, state.viewport.bounds, runScan]);

  const handleViewport = useCallback((viewport: RavenViewport) => {
    setMapReady(true);
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

  function setGpsOrigin() {
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

  function setScanOrigin() {
    const point = state.scan.center || state.viewport.center;
    dispatch({ type: 'REFERENCE_ORIGIN_SET', point, source: 'scan' });
    addLog('ORIGIN', 'DISTANCE / AZIMUTH REFERENCE SET TO SCAN CENTER');
  }

  function toggleLayer(layer: LayerKey) {
    dispatch({ type: 'LAYER_TOGGLE', layer });
    addLog('LAYER', `${layer.toUpperCase()} TOGGLED`);
  }

  function exportView() {
    const stamp = new Date().toISOString();
    downloadGeoJson(`raven-cameras-${stamp.slice(0, 10)}.geojson`, featuresToGeoJson(visible, stamp));
    addLog('EXPORT', `${visible.length} VISIBLE CONTACTS EXPORTED AS GEOJSON`);
  }

  async function clearCache() {
    await clearProviderCache();
    addLog('CACHE', 'BROWSER PROVIDER CACHE CLEARED');
  }

  const statusLabel = ACTIVITY_LABEL[activity] ?? SCAN_STATUS_LABEL[state.scan.status];
  const statusTone = state.scan.status === 'error' ? 'bad'
    : state.scan.status === 'dirty' || state.scan.status === 'partial' ? 'warn'
    : activity !== 'READY' || state.scan.status === 'scanning' ? 'busy'
    : 'ok';
  const canScan = state.mode !== 'detecting' && mapReady && state.scan.status !== 'scanning';
  const nearest = enriched[0];
  const selectedClass = selected ? MARKER_BY_KEY[markerKey(selected)] : null;
  const selectedEditUrl = selected ? osmEditUrl(selected) : undefined;

  function openSide(tab: SideTab) {
    setSideTab(tab);
    setMobilePanel('side');
  }

  return (
    <div className={`raven-app scan-${state.scan.status}`}>
      <div className="map-layer">
        <RavenMap
          initialView={initialView}
          features={visible}
          selectedId={state.selectionId}
          scanBounds={state.scan.bounds}
          origin={state.referenceOrigin}
          heatEnabled={state.layers.heat}
          outlineEnabled={state.layers.scanOutline}
          fovEnabled={state.layers.fov}
          ringsEnabled={state.layers.rings}
          recentPoints={recentPoints}
          recentEnabled={state.layers.recent}
          focus={focus}
          onViewportChange={handleViewport}
          onSelect={id => dispatch({ type: 'SELECT', id })}
          onBasemap={source => addLog('MAP', source === 'openfreemap' ? 'BASEMAP · OPENFREEMAP VECTOR' : 'BASEMAP UNAVAILABLE · OSM RASTER FALLBACK', source === 'openfreemap' ? 'info' : 'warn')}
        />
        <div className="map-vignette" aria-hidden="true" />
        <div className="origin-reticle" aria-hidden="true" />
        {state.scan.status === 'scanning' && <div className="scan-sweep" aria-hidden="true" />}
      </div>

      <header className="topbar glass">
        <div className="brand">
          <span className="brand-mark"><Radar size={18} strokeWidth={2.2} /></span>
          <span className="brand-text"><strong>Raven</strong><small>Open-data camera awareness</small></span>
        </div>
        <form className="search" role="search" onSubmit={submitSearch}>
          <Search size={16} aria-hidden="true" />
          <input aria-label="Search city, address, or coordinates" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search a place, address or lat, lon" />
          <button type="submit" className="icon-button" aria-label="Go"><ArrowRight size={16} /></button>
        </form>
        <div className="telemetry">
          <Telemetry label="Origin" value={`${state.referenceOrigin.lat.toFixed(4)}, ${state.referenceOrigin.lon.toFixed(4)}`} sub={state.referenceOrigin.source} />
          <Telemetry label="Zoom" value={`z${state.viewport.zoom.toFixed(1)}`} sub={state.scan.status === 'dirty' ? 'stale' : 'synced'} />
          <Telemetry label="Visible" value={String(enriched.length)} sub={`${fetched.length} fetched`} />
          <Telemetry label="UTC" value={clock.toISOString().slice(11, 19)} />
        </div>
        <div className={`status-pill tone-${statusTone}`}>
          <i className="status-dot" aria-hidden="true" />
          <strong role="status">{statusLabel}</strong>
          <small>{MODE_LABEL[state.mode]}</small>
        </div>
      </header>

      <aside className={`contacts panel glass ${mobilePanel === 'contacts' ? 'sheet-active' : ''}`} aria-label="Contacts">
        <div className="panel-head">
          <h2><List size={15} aria-hidden="true" />Contacts</h2>
          <span className="count-chip contacts-count">{registerFilter.trim() ? `${registerFeatures.length} / ${enriched.length}` : enriched.length}</span>
          <button className="icon-button sheet-close" aria-label="Close contacts" onClick={() => setMobilePanel('none')}><X size={16} /></button>
        </div>
        <label className="filter-field">
          <Filter size={14} aria-hidden="true" />
          <input type="search" aria-label="Filter contact register" placeholder="Filter by name, route, operator…" value={registerFilter} onChange={event => setRegisterFilter(event.target.value)} />
        </label>
        <VirtualContactList features={registerFeatures} selectedId={state.selectionId} onSelect={id => dispatch({ type: 'SELECT', id })} />
      </aside>

      <aside className={`side panel glass ${mobilePanel === 'side' ? 'sheet-active' : ''}`} aria-label="Analysis">
        <div className="panel-head">
          <div className="tabs" role="tablist" aria-label="Analysis panels">
            {SIDE_TABS.map(tab => (
              <button
                key={tab.key}
                role="tab"
                id={`tab-${tab.key}`}
                aria-selected={sideTab === tab.key}
                aria-controls="side-body"
                className="tab"
                onClick={() => setSideTab(tab.key)}
              >
                <tab.icon size={14} aria-hidden="true" />{tab.label}
              </button>
            ))}
          </div>
          <button className="icon-button sheet-close" aria-label="Close panel" onClick={() => setMobilePanel('none')}><X size={16} /></button>
        </div>
        <div className="side-body" id="side-body" role="tabpanel" aria-labelledby={`tab-${sideTab}`}>
          {sideTab === 'overview' && (
            <div className="stack">
              <div className="stat-grid">
                <StatTile icon={Eye} label="Visible" value={String(enriched.length)} sub={`${fetched.length} fetched`} />
                <StatTile icon={Target} label="Nearest" value={nearest ? formatRange(nearest.distance) : '—'} sub={nearest ? MARKER_BY_KEY[markerKey(nearest)].label : 'No camera in view'} />
              </div>
              {osmChanges && (
                <section className="card stat-card newly-mapped">
                  <h3 className="eyebrow">Newly mapped · OSM</h3>
                  <strong>+{osmChanges.addedCount}</strong>
                  <small>{osmChanges.removedCount} removed · {osmChanges.since?.slice(0, 10) ?? '—'} → {osmChanges.until?.slice(0, 10) ?? '—'}</small>
                  {osmChanges.feed && <a className="text-link" href={new URL(`osm/${osmChanges.feed}`, STATIC_API_BASE).href}><Rss size={13} aria-hidden="true" />Atom feed</a>}
                </section>
              )}
              <section className="card">
                <h3 className="eyebrow">Classification</h3>
                <div className="class-list">
                  {MARKER_CLASSES.map(marker => (
                    <div className="class-row" key={marker.key}>
                      <MarkerSwatch marker={marker} />
                      <span className="class-label">{marker.label}</span>
                      <span className="class-value">{classCounts[marker.key]}</span>
                      <span className="class-bar" aria-hidden="true">
                        <i style={{ width: `${visible.length ? (classCounts[marker.key] / visible.length) * 100 : 0}%`, background: marker.color }} />
                      </span>
                    </div>
                  ))}
                </div>
                <p className="muted-note">{facingCount} with a published viewing direction</p>
              </section>
            </div>
          )}
          {sideTab === 'layers' && (
            <LayerPanel
              layers={state.layers}
              autoScan={state.autoScan}
              onToggle={toggleLayer}
              onAutoScan={value => { dispatch({ type: 'AUTO_SCAN_SET', value }); addLog('SCAN', `AUTO SCAN ${value ? 'ENABLED' : 'DISABLED'}`); }}
            />
          )}
          {sideTab === 'sources' && (
            <div className="stack">
              <section className="card">
                <h3 className="eyebrow">Providers</h3>
                {ravenProviders.map(provider => <SourceRow key={provider.id} name={provider.name} run={state.providers[provider.id]} />)}
              </section>
              <section className="card">
                <h3 className="eyebrow">Data &amp; attribution</h3>
                <p className="muted-note">Public and open data only. © OpenStreetMap contributors (ODbL) · OpenFreeMap · FL511 / Florida DOT · Caltrans.</p>
                <a className="text-link" href={new URL('index.json', STATIC_API_BASE).href} target="_blank" rel="noreferrer"><ExternalLink size={13} aria-hidden="true" />Public camera API</a>
              </section>
            </div>
          )}
          {sideTab === 'log' && <LogView logs={state.logs} />}
        </div>
      </aside>

      <div className="legend glass" aria-label="Map legend">
        {MARKER_CLASSES.map(marker => (
          <span key={marker.key} className={`legend-item ${state.layers[marker.layer] ? '' : 'is-off'}`}><MarkerSwatch marker={marker} />{marker.label}</span>
        ))}
      </div>

      {state.scan.status === 'dirty' && (
        <div className="toast glass">
          <RefreshCw size={15} aria-hidden="true" />
          <span>Map moved — results are from the previous scan</span>
          <button onClick={() => void runScan('manual')}>Rescan</button>
        </div>
      )}

      {selected && selectedClass && (
        <section className="detail-card glass" aria-label="Contact detail">
          <header className="detail-head">
            <MarkerSwatch marker={selectedClass} size={18} />
            <div className="detail-title">
              <small className="eyebrow">{selectedClass.label}</small>
              <strong className="detail-name">{selected.name || 'Camera'}</strong>
            </div>
            <button className="icon-button" aria-label="Close contact detail" onClick={() => dispatch({ type: 'SELECT', id: null })}><X size={16} /></button>
          </header>
          <div className="detail-scroll">
            <CameraViewer key={selected.id} feature={selected} />
            <dl className="facts">
              <Fact label="Range" value={formatRange(selected.distance)} />
              <Fact label="Azimuth" value={`${Math.round(selected.azimuth)}°`} />
              <Fact label="Facing" value={selected.directionLabel || (selected.bearing === undefined ? 'Unknown' : `${selected.bearing}°`)} />
              <Fact label="Type" value={selected.cameraType && selected.cameraType !== 'unknown' ? selected.cameraType.toUpperCase() : '—'} />
              <Fact label="Operator" value={selected.operator || 'Unspecified'} />
              {selected.manufacturer && <Fact label="Manufacturer" value={selected.manufacturer} />}
              <Fact label="Provider" value={providerById(selected.providerId)?.name || selected.providerId} />
              <Fact label="Coordinates" value={`${selected.lat.toFixed(6)}, ${selected.lon.toFixed(6)}`} wide mono />
              {selected.sourceUpdatedAt && <Fact label="Source update" value={selected.sourceUpdatedAt} wide mono />}
            </dl>
            <div className="detail-actions">
              {selected.sourceUrl && <a className="action-link" href={selected.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden="true" />Open public source</a>}
              {selectedEditUrl && <a className="action-link" href={selectedEditUrl} target="_blank" rel="noreferrer"><PencilLine size={14} aria-hidden="true" />Edit on OpenStreetMap</a>}
            </div>
            <details className="raw-details"><summary>Raw provider metadata</summary><pre>{JSON.stringify(selected.metadata, null, 2)}</pre></details>
            <div className="detail-source">{selected.attribution || selected.providerId}</div>
          </div>
        </section>
      )}

      <nav className="dock glass" aria-label="Actions">
        <button className="dock-button primary" aria-label="Scan view" disabled={!canScan} onClick={() => void runScan('manual')}><Radar size={17} aria-hidden="true" /><span>Scan view</span></button>
        <span className="dock-divider" aria-hidden="true" />
        <button className="dock-button" aria-label="GPS origin" title="Measure ranges from your location" onClick={setGpsOrigin}><LocateFixed size={17} aria-hidden="true" /><span>GPS origin</span></button>
        <button className="dock-button" aria-label="Scan origin" title="Measure ranges from the scan centre" onClick={setScanOrigin}><Crosshair size={17} aria-hidden="true" /><span>Scan origin</span></button>
        <button className={`dock-button ${state.autoScan ? 'is-on' : ''}`} aria-label="Auto scan" aria-pressed={state.autoScan} title="Rescan shortly after the map stops moving" onClick={() => dispatch({ type: 'AUTO_SCAN_SET', value: !state.autoScan })}><RefreshCw size={17} aria-hidden="true" /><span>Auto scan</span></button>
        <span className="dock-divider" aria-hidden="true" />
        <button className="dock-button" aria-label="Export GeoJSON" title="Download the visible cameras as GeoJSON" disabled={visible.length === 0} onClick={exportView}><Download size={17} aria-hidden="true" /><span>Export</span></button>
        <a className="dock-button" aria-label="Add camera to OSM" href={osmAddUrl(state.viewport.center)} target="_blank" rel="noreferrer" title="Map a missing camera in OpenStreetMap at the map centre"><MapPinPlus size={17} aria-hidden="true" /><span>Add camera</span></a>
        <button className="dock-button" aria-label="Clear cache" title="Clear the browser provider cache" onClick={() => void clearCache()}><Trash2 size={17} aria-hidden="true" /><span>Clear cache</span></button>
      </nav>

      <nav className="mobile-tabs" aria-label="Raven panels">
        <button className={mobilePanel === 'contacts' ? 'is-active' : ''} onClick={() => setMobilePanel(mobilePanel === 'contacts' ? 'none' : 'contacts')}><List size={18} aria-hidden="true" />Contacts</button>
        {SIDE_TABS.map(tab => (
          <button key={tab.key} className={mobilePanel === 'side' && sideTab === tab.key ? 'is-active' : ''} onClick={() => (mobilePanel === 'side' && sideTab === tab.key ? setMobilePanel('none') : openSide(tab.key))}>
            <tab.icon size={18} aria-hidden="true" />{tab.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

type SideTab = 'overview' | 'layers' | 'sources' | 'log';

const SIDE_TABS: Array<{ key: SideTab; label: string; icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean | 'true' }> }> = [
  { key: 'overview', label: 'Overview', icon: Activity },
  { key: 'layers', label: 'Layers', icon: Layers },
  { key: 'sources', label: 'Sources', icon: Database },
  { key: 'log', label: 'Log', icon: TerminalSquare }
];

const ACTIVITY_LABEL: Record<string, string> = { SCANNING: 'Scanning…', SEARCHING: 'Searching…', LOCATING: 'Locating…' };
const SCAN_STATUS_LABEL = {
  idle: 'Ready to scan',
  dirty: 'Results stale',
  scanning: 'Scanning…',
  partial: 'Partial results',
  ready: 'Ready',
  error: 'Source error'
} as const;
const MODE_LABEL: Record<RavenMode, string> = { detecting: 'Detecting', static: 'Web', local: 'Local' };

function Telemetry({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="telemetry-item"><span>{label}</span><strong>{value}</strong>{sub && <small>{sub}</small>}</div>;
}

function StatTile({ icon: Icon, label, value, sub }: { icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean | 'true' }>; label: string; value: string; sub: string }) {
  return (
    <section className="card stat-tile">
      <h3 className="eyebrow"><Icon size={13} aria-hidden="true" />{label}</h3>
      <strong>{value}</strong>
      <small>{sub}</small>
    </section>
  );
}

function Fact({ label, value, wide, mono }: { label: string; value: string; wide?: boolean; mono?: boolean }) {
  return <div className={`fact ${wide ? 'is-wide' : ''}`}><dt>{label}</dt><dd className={mono ? 'mono' : ''}>{value}</dd></div>;
}

function SourceRow({ name, run }: { name: string; run?: ProviderRun }) {
  const status = run?.status || 'idle';
  const progress = run?.progress ? `${run.progress.completed}/${run.progress.total}` : '';
  const detail = run?.error || run?.warning || run?.skipReason;
  return (
    <div className={`source-row status-${status}`}>
      <i className="status-dot" aria-hidden="true" />
      <div className="source-text">
        <strong>{name}</strong>
        {detail && <small className={run?.error ? 'is-error' : run?.warning ? 'is-warning' : ''}>{detail}</small>}
      </div>
      <span className="chip">{status}{run?.features.length ? ` · ${run.features.length}` : ''}{progress ? ` · ${progress}` : ''}{run?.fromCache ? ' · cache' : ''}</span>
    </div>
  );
}

function LogView({ logs }: { logs: RavenLogEntry[] }) {
  return (
    <div className="log-view">
      <div className="log-meta">{logs.length} events</div>
      <div className="log-lines">
        {logs.map(entry => (
          <div key={entry.id} className={`log-line log-${entry.level}`}>
            <time>{new Date(entry.timestamp).toISOString().slice(11, 19)}</time>
            <b>{entry.channel}</b>
            <span>{entry.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

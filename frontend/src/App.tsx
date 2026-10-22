import { FormEvent, useCallback, useEffect, useMemo, useReducer, useRef, useState, type ComponentType } from 'react';
import {
  Activity, ArrowRight, Check, Database, Download, ExternalLink, Eye, Filter, Layers, Link2, List, LocateFixed, MapPinPlus, PencilLine, Radar, Search, Target, X, ZoomIn
} from 'lucide-react';
import { CameraViewer } from './components/CameraViewer';
import { LayerPanel } from './components/LayerPanel';
import { MarkerSwatch } from './components/MarkerSwatch';
import { OSM_LIST_ZOOM, RavenMap, type MapFocus, type OsmViewSummary } from './components/RavenMap';
import { VirtualContactList, type EnrichedFeature } from './components/VirtualContactList';
import { boundsContain, filterByBounds, padBounds } from './data/bounds';
import { loadCatalog, type Catalog } from './data/catalog';
import { osmVectorUrl } from './data/osmVector';
import { downloadGeoJson, featuresToGeoJson } from './exportGeoJson';
import { matchesFilter } from './filter';
import { bearingDegrees, distanceMeters, formatRange } from './geo';
import { MARKER_BY_KEY, MARKER_CLASSES, markerKey, type MarkerKey } from './markers';
import { abortError } from './net';
import { osmAddUrl, osmEditUrl } from './osmLinks';
import { formatViewHash, parseViewHash } from './permalink';
import { loadPreferences, savePreferences } from './preferences';
import { normalizeElement, osmProvider } from './providers/osm';
import { loadOsmChanges, loadTileElements, loadTileIndex, type OsmChanges, type OsmTileIndex } from './providers/osmTiles';
import { providerById, ravenProviders } from './providers/registry';
import { providerEligibility, type RavenProvider } from './providers/types';
import { searchPlace } from './search';
import { allFeatures, createInitialState, DEFAULT_VIEW, featureVisible, LAYER_KEYS, overallStatus, ravenReducer, type DataSet } from './state';
import type { DataStatus, RavenBounds, RavenFeature, RavenMode, RavenViewport } from './types';

// Raven's static API (camera catalog, OSM tiles) sits beside the app on Pages and in Raven Local.
const STATIC_API_BASE = new URL('api/v1/', document.baseURI).href;
/** Provider requests (used only without published data) cover this much more than the view, so small pans are free. */
const PROVIDER_PADDING = 0.35;
const CATALOG_PADDING = 0.1;

async function detectMode(): Promise<RavenMode> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 1100);
  try {
    const response = await fetch(`${window.location.origin}/api/health`, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) return 'static';
    const payload = await response.json();
    return payload?.service === 'raven' ? 'local' : 'static';
  } catch {
    return 'static';
  } finally {
    clearTimeout(timer);
  }
}

function osmAttributionFor(index: OsmTileIndex | null): string {
  if (!index) return '© OpenStreetMap contributors';
  return `© OpenStreetMap contributors · ${index.source}${index.dataTimestamp ? `, data as of ${index.dataTimestamp.slice(0, 10)}` : ''}`;
}

export default function App() {
  // A shared #map=zoom/lat/lon link opens on that view; saved layer choices are restored.
  const [initialView] = useState(() => parseViewHash(window.location.hash) ?? DEFAULT_VIEW);
  const [state, dispatch] = useReducer(ravenReducer, undefined, () => createInitialState(initialView, loadPreferences(LAYER_KEYS).layers));
  const [query, setQuery] = useState('');
  const [registerFilter, setRegisterFilter] = useState('');
  const [osmChanges, setOsmChanges] = useState<OsmChanges | null>(null);
  const [osmIndex, setOsmIndex] = useState<OsmTileIndex | null>(null);
  const [osmEstimate, setOsmEstimate] = useState(0);
  const [dataReady, setDataReady] = useState(false);
  const [activity, setActivity] = useState<'READY' | 'SEARCHING' | 'LOCATING'>('READY');
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [focus, setFocus] = useState<MapFocus>(null);
  const [mobilePanel, setMobilePanel] = useState<'none' | 'contacts' | 'side'>('none');
  const [sideTab, setSideTab] = useState<SideTab>('overview');
  const [mapReady, setMapReady] = useState(false);
  // A camera clicked on the map before it reached the list, and its full OSM record once fetched.
  const [pinned, setPinned] = useState<RavenFeature | null>(null);
  const [detail, setDetail] = useState<RavenFeature | null>(null);
  const catalogRef = useRef<Catalog | null>(null);
  const providerControllers = useRef<Record<'live' | 'osm', AbortController | null>>({ live: null, osm: null });
  const searchControllerRef = useRef<AbortController | null>(null);

  const osmTilesUrl = osmVectorUrl(STATIC_API_BASE, osmIndex);
  const osmAttribution = osmAttributionFor(osmIndex);

  const loaded = useMemo(() => {
    const list = allFeatures(state);
    return pinned && !list.some(feature => feature.id === pinned.id) ? [...list, pinned] : list;
  }, [state, pinned]);
  const visible = useMemo(() => loaded.filter(feature => featureVisible(feature, state.layers)), [loaded, state.layers]);
  const enriched = useMemo<EnrichedFeature[]>(() => visible.map(feature => ({
    ...feature,
    distance: distanceMeters(state.referenceOrigin.lat, state.referenceOrigin.lon, feature.lat, feature.lon),
    azimuth: bearingDegrees(state.referenceOrigin.lat, state.referenceOrigin.lon, feature.lat, feature.lon)
  })).sort((a, b) => a.distance - b.distance), [visible, state.referenceOrigin]);
  const selectedBase = enriched.find(feature => feature.id === state.selectionId) || null;
  const selected = selectedBase && detail?.id === selectedBase.id ? { ...selectedBase, ...detail } : selectedBase;
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

  // ---- Data: published catalog and tiles first, on-demand providers as the fallback -------
  useEffect(() => {
    let active = true;
    void detectMode().then(mode => active && dispatch({ type: 'MODE_SET', mode }));
    void loadOsmChanges(STATIC_API_BASE).then(changes => active && changes && setOsmChanges(changes));
    void Promise.all([loadTileIndex(STATIC_API_BASE), loadCatalog(STATIC_API_BASE)]).then(([index, catalog]) => {
      if (!active) return;
      setOsmIndex(index);
      catalogRef.current = catalog;
      dispatch({
        type: 'DATA_SET',
        set: 'live',
        patch: catalog ? { source: 'catalog', status: 'ready', generatedAt: catalog.generatedAt, features: [] } : { source: 'providers', status: 'idle' }
      });
      dispatch({
        type: 'DATA_SET',
        set: 'osm',
        patch: index?.vectorTiles ? { source: 'tiles', status: 'loading', generatedAt: index.dataTimestamp } : { source: 'providers', status: 'idle', generatedAt: index?.dataTimestamp ?? null }
      });
      setDataReady(true);
    });
    const controllers = providerControllers.current;
    return () => {
      active = false;
      searchControllerRef.current?.abort();
      for (const controller of Object.values(controllers)) controller?.abort();
    };
  }, []);

  // The catalog is in memory: each move is a filter, not a request.
  useEffect(() => {
    const catalog = catalogRef.current;
    if (!catalog || state.live.source !== 'catalog') return;
    dispatch({ type: 'DATA_SET', set: 'live', patch: { features: filterByBounds(catalog.features, padBounds(state.viewport.bounds, CATALOG_PADDING)), bounds: state.viewport.bounds } });
  }, [state.viewport.bounds, state.live.source]);

  const runProviders = useCallback(async (set: 'live' | 'osm', providers: RavenProvider[], viewport: RavenViewport, mode: RavenMode) => {
    providerControllers.current[set]?.abort();
    const controller = new AbortController();
    providerControllers.current[set] = controller;
    const bounds = padBounds(viewport.bounds, PROVIDER_PADDING);
    const eligible = providers.filter(provider => providerEligibility(provider, bounds, viewport.zoom).active);
    const skipped = providers.filter(provider => !eligible.includes(provider)).map(provider => providerEligibility(provider, bounds, viewport.zoom).reason);
    if (!eligible.length) {
      dispatch({ type: 'DATA_SET', set, patch: { status: 'idle', bounds: undefined, features: [], warning: skipped[0] ? `Zoom in to load (${skipped[0].toLowerCase()})` : undefined, error: undefined } });
      return;
    }
    dispatch({ type: 'DATA_SET', set, patch: { status: 'loading', warning: undefined, error: undefined } });
    const collected = new Map<string, RavenFeature[]>();
    const publish = () => dispatch({ type: 'DATA_SET', set, patch: { features: Array.from(collected.values()).flat() } });
    const outcomes = await Promise.all(eligible.map(async provider => {
      try {
        const result = await provider.scan({
          mode,
          bounds,
          zoom: viewport.zoom,
          staticApiBase: STATIC_API_BASE,
          onProgress: features => {
            if (controller.signal.aborted) return;
            collected.set(provider.id, features);
            publish();
          }
        }, controller.signal);
        collected.set(provider.id, result.features);
        return { warning: result.warning };
      } catch (error) {
        if (controller.signal.aborted || abortError(error)) return { aborted: true };
        return { error: error instanceof Error ? error.message : `${provider.name} failed` };
      }
    }));
    if (controller.signal.aborted) return;
    const errors = outcomes.filter(outcome => outcome.error).map(outcome => outcome.error as string);
    const warnings = outcomes.filter(outcome => outcome.warning).map(outcome => outcome.warning as string);
    const status: DataStatus = errors.length === eligible.length ? 'error' : errors.length || warnings.length ? 'partial' : 'ready';
    dispatch({ type: 'DATA_SET', set, patch: { status, bounds, features: Array.from(collected.values()).flat(), warning: warnings[0], error: errors[0] } });
  }, []);

  // Without published data, ask the providers for the area around the view, and again only
  // once the view leaves that area.
  const { mode, viewport, live, osm } = state;
  useEffect(() => {
    if (!dataReady || !mapReady || mode === 'detecting') return;
    const timer = window.setTimeout(() => {
      for (const [set, data] of [['live', live], ['osm', osm]] as const) {
        if (data.source !== 'providers' || data.status === 'loading') continue;
        if (data.bounds && boundsContain(data.bounds, viewport.bounds)) continue;
        const providers = set === 'osm' ? [osmProvider] : ravenProviders.filter(provider => provider.id !== osmProvider.id);
        void runProviders(set, providers, viewport, mode);
      }
    }, 600);
    return () => window.clearTimeout(timer);
  }, [dataReady, mapReady, mode, viewport, live, osm, runProviders]);

  const lastOsmView = useRef<string | null>(null);
  const handleOsmView = useCallback((summary: OsmViewSummary) => {
    if (summary.estimate < 0) {
      dispatch({ type: 'DATA_SET', set: 'osm', patch: { status: 'error', error: 'The OpenStreetMap tiles could not be loaded' } });
      return;
    }
    setOsmEstimate(summary.estimate);
    // The map settles often; only a changed set of cameras is worth a render.
    const signature = summary.features.map(feature => feature.id).join(',');
    if (signature === lastOsmView.current) return;
    lastOsmView.current = signature;
    dispatch({ type: 'DATA_SET', set: 'osm', patch: { status: 'ready', features: summary.features, error: undefined } });
  }, []);

  // ---- Selection: tile points carry a few fields; the full OSM record is fetched on demand -
  const select = useCallback((id: string | null, feature?: RavenFeature) => {
    dispatch({ type: 'SELECT', id });
    setPinned(feature ?? null);
    setDetail(null);
  }, []);

  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  useEffect(() => {
    const target = loadedRef.current.find(feature => feature.id === state.selectionId);
    const index = osmIndex;
    if (!target || !index || target.providerId !== 'osm-overpass' || Object.keys(target.metadata).length) return;
    const controller = new AbortController();
    const nodeId = Number(target.sourceId);
    // Tile coordinates are quantised to a few metres, so look a little around the point and match by id.
    const around: RavenBounds = { west: target.lon - 0.001, east: target.lon + 0.001, south: target.lat - 0.001, north: target.lat + 0.001 };
    void loadTileElements(index, STATIC_API_BASE, around, controller.signal, elements => {
      const element = elements.find(item => item.id === nodeId);
      const full = element ? normalizeElement(element) : null;
      if (full && !controller.signal.aborted) setDetail({ ...full, attribution: osmAttributionFor(index) });
    }).catch(() => undefined);
    return () => controller.abort();
  }, [state.selectionId, osmIndex]);

  useEffect(() => {
    if (state.selectionId && !visible.some(feature => feature.id === state.selectionId)) select(null);
  }, [state.selectionId, visible, select]);

  // ---- Shell ----------------------------------------------------------------------------------
  useEffect(() => savePreferences({ layers: state.layers }), [state.layers]);

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
      else if (state.selectionId) select(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobilePanel, state.selectionId, select]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

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
      if (!result) throw new Error('No matching place');
      setFocus({ lat: result.lat, lon: result.lon, zoom: 14, token: Date.now() });
    } catch (error) {
      if (!abortError(error)) setNotice(error instanceof Error ? error.message : 'Search failed');
    } finally {
      if (!controller.signal.aborted) setActivity('READY');
    }
  }

  function toggleGpsOrigin() {
    if (state.referenceOrigin.source === 'gps') {
      dispatch({ type: 'REFERENCE_ORIGIN_SET', point: state.viewport.center, source: 'map' });
      return;
    }
    if (!navigator.geolocation) {
      setNotice('This browser has no location support');
      return;
    }
    setActivity('LOCATING');
    navigator.geolocation.getCurrentPosition(position => {
      const point = { lat: position.coords.latitude, lon: position.coords.longitude };
      dispatch({ type: 'REFERENCE_ORIGIN_SET', point, source: 'gps' });
      setFocus({ ...point, zoom: 15, token: Date.now() });
      setActivity('READY');
    }, error => {
      setNotice(error.message || 'Location unavailable');
      setActivity('READY');
    }, { enableHighAccuracy: true, timeout: 8000 });
  }

  async function shareLink() {
    const url = window.location.href;
    try {
      if (navigator.share && !navigator.clipboard) await navigator.share({ title: 'Raven', url });
      else await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setNotice('Copy the address bar to share this view');
    }
  }

  function exportView() {
    const stamp = new Date().toISOString();
    downloadGeoJson(`raven-cameras-${stamp.slice(0, 10)}.geojson`, featuresToGeoJson(visible, stamp));
  }

  const status = overallStatus(state);
  const statusLabel = activity === 'SEARCHING' ? 'Searching…' : activity === 'LOCATING' ? 'Locating…' : STATUS_LABEL[status];
  const statusTone = status === 'error' ? 'bad' : status === 'partial' ? 'warn' : activity !== 'READY' || status === 'loading' ? 'busy' : status === 'idle' ? 'warn' : 'ok';
  const osmListHidden = state.osm.source === 'tiles' && state.viewport.zoom < OSM_LIST_ZOOM;
  const nearest = enriched[0];
  const selectedClass = selected ? MARKER_BY_KEY[markerKey(selected)] : null;
  const selectedEditUrl = selected ? osmEditUrl(selected) : undefined;
  const dataDate = state.osm.generatedAt?.slice(0, 10) ?? state.live.generatedAt?.slice(0, 10);

  function openSide(tab: SideTab) {
    setSideTab(tab);
    setMobilePanel('side');
  }

  return (
    <div className={`raven-app data-${status}`}>
      <div className="map-layer">
        <RavenMap
          initialView={initialView}
          features={visible.filter(feature => state.osm.source !== 'tiles' || feature.providerId !== 'osm-overpass')}
          selectedId={state.selectionId}
          origin={state.referenceOrigin}
          layers={state.layers}
          osmTilesUrl={osmTilesUrl}
          osmAttribution={osmAttribution}
          recentPoints={recentPoints}
          focus={focus}
          onViewportChange={handleViewport}
          onSelect={select}
          onOsmView={handleOsmView}
        />
        <div className="map-vignette" aria-hidden="true" />
        <div className="origin-reticle" aria-hidden="true" />
      </div>

      <header className="topbar">
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
          <Telemetry label="Origin" value={`${state.referenceOrigin.lat.toFixed(4)}, ${state.referenceOrigin.lon.toFixed(4)}`} sub={state.referenceOrigin.source === 'gps' ? 'my location' : 'map centre'} />
          <Telemetry label="In view" value={osmListHidden && osmEstimate ? `≈${osmEstimate.toLocaleString()}` : String(enriched.length)} sub={osmListHidden ? 'zoom in to list' : 'cameras'} />
          {dataDate && <Telemetry label="Data" value={dataDate} sub={state.osm.source === 'tiles' ? 'OSM extract' : 'published'} />}
        </div>
        <div className={`status-pill tone-${statusTone}`}>
          <i className="status-dot" aria-hidden="true" />
          <strong role="status">{statusLabel}</strong>
          <small>{MODE_LABEL[state.mode]}</small>
        </div>
      </header>

      <aside className={`contacts panel ${mobilePanel === 'contacts' ? 'sheet-active' : ''}`} aria-label="Contacts">
        <div className="panel-head">
          <h2><List size={15} aria-hidden="true" />Cameras in view</h2>
          <span className="count-chip contacts-count">{registerFilter.trim() ? `${registerFeatures.length} / ${enriched.length}` : enriched.length}</span>
          <button className="icon-button sheet-close" aria-label="Close contacts" onClick={() => setMobilePanel('none')}><X size={16} /></button>
        </div>
        <label className="filter-field">
          <Filter size={14} aria-hidden="true" />
          <input type="search" aria-label="Filter contact register" placeholder="Filter by name, route, operator…" value={registerFilter} onChange={event => setRegisterFilter(event.target.value)} />
        </label>
        {osmListHidden && (
          <p className="panel-note"><ZoomIn size={14} aria-hidden="true" />Zoom in to list OpenStreetMap cameras{osmEstimate ? ` · about ${osmEstimate.toLocaleString()} in view` : ''}</p>
        )}
        {state.osm.source === 'providers' && state.osm.warning && state.osm.status === 'idle' && (
          <p className="panel-note"><ZoomIn size={14} aria-hidden="true" />{state.osm.warning}</p>
        )}
        <VirtualContactList features={registerFeatures} selectedId={state.selectionId} onSelect={id => select(id)} />
      </aside>

      <aside className={`side panel ${mobilePanel === 'side' ? 'sheet-active' : ''}`} aria-label="Analysis">
        <div className="panel-head">
          <div className="tabs" role="tablist" aria-label="Analysis panels">
            {SIDE_TABS.map(tab => (
              <button key={tab.key} role="tab" id={`tab-${tab.key}`} aria-selected={sideTab === tab.key} aria-controls="side-body" className="tab" onClick={() => setSideTab(tab.key)}>
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
                <StatTile icon={Eye} label="In view" value={osmListHidden && osmEstimate ? `≈${osmEstimate.toLocaleString()}` : String(enriched.length)} sub={osmListHidden ? 'zoom in for the list' : `${loaded.length} loaded`} />
                <StatTile icon={Target} label="Nearest" value={nearest ? formatRange(nearest.distance) : '—'} sub={nearest ? MARKER_BY_KEY[markerKey(nearest)].label : 'No camera listed'} />
              </div>
              {osmChanges && (
                <section className="card stat-card newly-mapped">
                  <h3 className="eyebrow">Newly mapped · OSM</h3>
                  <strong>+{osmChanges.addedCount}</strong>
                  <small>{osmChanges.removedCount} removed · {osmChanges.since?.slice(0, 10) ?? '—'} → {osmChanges.until?.slice(0, 10) ?? '—'}</small>
                  {osmChanges.feed && <a className="text-link" href={new URL(`osm/${osmChanges.feed}`, STATIC_API_BASE).href}><ExternalLink size={13} aria-hidden="true" />Atom feed</a>}
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
          {sideTab === 'layers' && <LayerPanel layers={state.layers} onToggle={layer => dispatch({ type: 'LAYER_TOGGLE', layer })} />}
          {sideTab === 'sources' && (
            <div className="stack">
              <section className="card">
                <h3 className="eyebrow">Data sets</h3>
                <SourceRow
                  name="Live traffic cameras"
                  data={state.live}
                  detail={state.live.source === 'catalog'
                    ? `Published catalog · ${catalogRef.current?.providers.map(id => providerById(id)?.name ?? id).join(', ') || 'no providers'}${state.live.generatedAt ? ` · ${state.live.generatedAt.slice(0, 10)}` : ''}`
                    : 'Requested from FL511 and Caltrans for the area in view'}
                />
                <SourceRow
                  name="OpenStreetMap cameras"
                  data={state.osm}
                  detail={state.osm.source === 'tiles' ? `Vector tiles from the ${osmIndex?.source ?? 'extract'}${state.osm.generatedAt ? ` · ${state.osm.generatedAt.slice(0, 10)}` : ''}` : 'Requested from Overpass for the area in view'}
                />
              </section>
              <section className="card">
                <h3 className="eyebrow">Data &amp; attribution</h3>
                <p className="muted-note">Public and open data only. © OpenStreetMap contributors (ODbL) · OpenFreeMap · FL511 / Florida DOT · Caltrans.</p>
                <a className="text-link" href={new URL('index.json', STATIC_API_BASE).href} target="_blank" rel="noreferrer"><ExternalLink size={13} aria-hidden="true" />Public camera API</a>
                <a className="text-link" href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noreferrer"><PencilLine size={13} aria-hidden="true" />Fix the map</a>
              </section>
            </div>
          )}
        </div>
      </aside>

      <div className="legend" aria-label="Map legend">
        {MARKER_CLASSES.map(marker => (
          <button
            key={marker.key}
            type="button"
            className={`legend-item ${state.layers[marker.layer] ? '' : 'is-off'}`}
            aria-pressed={state.layers[marker.layer]}
            title={`${state.layers[marker.layer] ? 'Hide' : 'Show'} ${marker.label.toLowerCase()}s`}
            onClick={() => dispatch({ type: 'LAYER_TOGGLE', layer: marker.layer })}
          >
            <MarkerSwatch marker={marker} />{marker.label}
          </button>
        ))}
      </div>

      {notice && <div className="toast" role="status"><span>{notice}</span></div>}

      {selected && selectedClass && (
        <section className="detail-card" aria-label="Contact detail">
          <header className="detail-head">
            <MarkerSwatch marker={selectedClass} size={18} />
            <div className="detail-title">
              <small className="eyebrow">{selectedClass.label}</small>
              <strong className="detail-name">{selected.name || 'Camera'}</strong>
            </div>
            <button className="icon-button" aria-label="Close contact detail" onClick={() => select(null)}><X size={16} /></button>
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
            {Object.keys(selected.metadata).length > 0 && <details className="raw-details"><summary>Raw provider metadata</summary><pre>{JSON.stringify(selected.metadata, null, 2)}</pre></details>}
            <div className="detail-source">{selected.attribution || selected.providerId}</div>
          </div>
        </section>
      )}

      <nav className="dock" aria-label="Actions">
        <button className={`dock-button ${state.referenceOrigin.source === 'gps' ? 'is-on' : ''}`} aria-label="Measure from my location" aria-pressed={state.referenceOrigin.source === 'gps'} title="Measure ranges from your location instead of the map centre" onClick={toggleGpsOrigin}><LocateFixed size={17} aria-hidden="true" /><span>My location</span></button>
        <button className="dock-button" aria-label="Share link" title="Copy a link to this view" onClick={() => void shareLink()}>{copied ? <Check size={17} aria-hidden="true" /> : <Link2 size={17} aria-hidden="true" />}<span>{copied ? 'Copied' : 'Share'}</span></button>
        <span className="dock-divider" aria-hidden="true" />
        <button className="dock-button" aria-label="Export GeoJSON" title="Download the listed cameras as GeoJSON" disabled={visible.length === 0} onClick={exportView}><Download size={17} aria-hidden="true" /><span>Export</span></button>
        <a className="dock-button" aria-label="Add camera to OSM" href={osmAddUrl(state.viewport.center)} target="_blank" rel="noreferrer" title="Map a missing camera in OpenStreetMap at the map centre"><MapPinPlus size={17} aria-hidden="true" /><span>Add camera</span></a>
      </nav>

      <nav className="mobile-tabs" aria-label="Raven panels">
        <button className={mobilePanel === 'contacts' ? 'is-active' : ''} onClick={() => setMobilePanel(mobilePanel === 'contacts' ? 'none' : 'contacts')}><List size={18} aria-hidden="true" />Cameras</button>
        {SIDE_TABS.map(tab => (
          <button key={tab.key} className={mobilePanel === 'side' && sideTab === tab.key ? 'is-active' : ''} onClick={() => (mobilePanel === 'side' && sideTab === tab.key ? setMobilePanel('none') : openSide(tab.key))}>
            <tab.icon size={18} aria-hidden="true" />{tab.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

type SideTab = 'overview' | 'layers' | 'sources';

const SIDE_TABS: Array<{ key: SideTab; label: string; icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean | 'true' }> }> = [
  { key: 'overview', label: 'Overview', icon: Activity },
  { key: 'layers', label: 'Layers', icon: Layers },
  { key: 'sources', label: 'Sources', icon: Database }
];

const STATUS_LABEL: Record<DataStatus, string> = {
  idle: 'Waiting for data',
  loading: 'Loading cameras…',
  ready: 'Up to date',
  partial: 'Some data unavailable',
  error: 'Data unavailable'
};
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

function SourceRow({ name, data, detail }: { name: string; data: DataSet; detail: string }) {
  const message = data.error || data.warning;
  return (
    <div className={`source-row status-${data.status}`}>
      <i className="status-dot" aria-hidden="true" />
      <div className="source-text">
        <strong>{name}</strong>
        <small>{detail}</small>
        {message && <small className={data.error ? 'is-error' : 'is-warning'}>{message}</small>}
      </div>
      <span className="chip">{STATUS_CHIP[data.status]}{data.features.length ? ` · ${data.features.length}` : ''}</span>
    </div>
  );
}

const STATUS_CHIP: Record<DataStatus, string> = { idle: 'waiting', loading: 'loading', ready: 'ready', partial: 'partial', error: 'error' };

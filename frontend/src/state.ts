import type {
  LayerKey,
  ProviderRun,
  RavenBounds,
  RavenFeature,
  RavenLogEntry,
  RavenMode,
  RavenPoint,
  RavenViewport,
  ScanStatus
} from './types';

export type RavenState = {
  mode: RavenMode;
  viewport: RavenViewport;
  referenceOrigin: RavenPoint & { source: 'scan' | 'gps' | 'manual' };
  scan: {
    id?: string;
    status: ScanStatus;
    bounds?: RavenBounds;
    center?: RavenPoint;
    startedAt?: number;
    completedAt?: number;
  };
  providers: Record<string, ProviderRun>;
  layers: Record<LayerKey, boolean>;
  selectionId: string | null;
  autoScan: boolean;
  logs: RavenLogEntry[];
};

export type RavenAction =
  | { type: 'MODE_SET'; mode: RavenMode }
  | { type: 'VIEWPORT_CHANGED'; viewport: RavenViewport; markDirty?: boolean }
  | { type: 'REFERENCE_ORIGIN_SET'; point: RavenPoint; source: 'scan' | 'gps' | 'manual' }
  | { type: 'SCAN_BEGIN'; id: string; bounds: RavenBounds; center: RavenPoint; activeProviderIds: string[]; allProviderIds: string[]; timestamp: number }
  | { type: 'PROVIDER_SUCCESS'; scanId: string; providerId: string; features: RavenFeature[]; pages?: number; timestamp: number }
  | { type: 'PROVIDER_ERROR'; scanId: string; providerId: string; error: string; timestamp: number }
  | { type: 'SCAN_FINISH'; scanId: string; status: Exclude<ScanStatus, 'idle' | 'dirty' | 'scanning'>; timestamp: number }
  | { type: 'LAYER_TOGGLE'; layer: LayerKey }
  | { type: 'LAYER_SET'; layer: LayerKey; value: boolean }
  | { type: 'AUTO_SCAN_SET'; value: boolean }
  | { type: 'SELECT'; id: string | null }
  | { type: 'LOG'; entry: RavenLogEntry }
  | { type: 'CLEAR_LOGS' };

const MIAMI = { lat: 25.7617, lon: -80.1918 };
const DEFAULT_BOUNDS: RavenBounds = { west: -80.24, south: 25.72, east: -80.14, north: 25.80 };

export function createInitialState(): RavenState {
  return {
    mode: 'detecting',
    viewport: { center: MIAMI, bounds: DEFAULT_BOUNDS, zoom: 13.4 },
    referenceOrigin: { ...MIAMI, source: 'scan' },
    scan: { status: 'idle' },
    providers: {},
    layers: {
      mappedCameras: true,
      snapshots: true,
      streams: true,
      speedCameras: true,
      heat: false,
      scanOutline: true
    },
    selectionId: null,
    autoScan: false,
    logs: [logEntry('SYSTEM', 'RAVEN STATE ENGINE INITIALIZED')]
  };
}

export function logEntry(channel: string, message: string, level: RavenLogEntry['level'] = 'info', timestamp = Date.now()): RavenLogEntry {
  return {
    id: `${timestamp}-${Math.random().toString(36).slice(2, 9)}`,
    timestamp,
    level,
    channel,
    message
  };
}

function boundsDiffer(a?: RavenBounds, b?: RavenBounds): boolean {
  if (!a || !b) return true;
  const epsilon = 0.0005;
  return Math.abs(a.west - b.west) > epsilon ||
    Math.abs(a.south - b.south) > epsilon ||
    Math.abs(a.east - b.east) > epsilon ||
    Math.abs(a.north - b.north) > epsilon;
}

export function ravenReducer(state: RavenState, action: RavenAction): RavenState {
  switch (action.type) {
    case 'MODE_SET':
      return { ...state, mode: action.mode };
    case 'VIEWPORT_CHANGED': {
      const shouldDirty = action.markDirty !== false &&
        ['ready', 'partial'].includes(state.scan.status) &&
        boundsDiffer(state.scan.bounds, action.viewport.bounds);
      return {
        ...state,
        viewport: action.viewport,
        scan: shouldDirty ? { ...state.scan, status: 'dirty' } : state.scan
      };
    }
    case 'REFERENCE_ORIGIN_SET':
      return { ...state, referenceOrigin: { ...action.point, source: action.source } };
    case 'SCAN_BEGIN': {
      const active = new Set(action.activeProviderIds);
      const providers = { ...state.providers };
      for (const providerId of action.allProviderIds) {
        providers[providerId] = {
          providerId,
          status: active.has(providerId) ? 'loading' : 'skipped',
          features: [],
          scanId: action.id
        };
      }
      return {
        ...state,
        scan: {
          id: action.id,
          status: 'scanning',
          bounds: action.bounds,
          center: action.center,
          startedAt: action.timestamp
        },
        referenceOrigin: state.referenceOrigin.source === 'scan'
          ? { ...action.center, source: 'scan' }
          : state.referenceOrigin,
        providers,
        selectionId: null
      };
    }
    case 'PROVIDER_SUCCESS': {
      if (state.scan.id !== action.scanId) return state;
      return {
        ...state,
        providers: {
          ...state.providers,
          [action.providerId]: {
            providerId: action.providerId,
            status: 'ready',
            features: action.features,
            fetchedAt: action.timestamp,
            scanId: action.scanId,
            pages: action.pages
          }
        }
      };
    }
    case 'PROVIDER_ERROR': {
      if (state.scan.id !== action.scanId) return state;
      return {
        ...state,
        providers: {
          ...state.providers,
          [action.providerId]: {
            providerId: action.providerId,
            status: 'error',
            features: [],
            error: action.error,
            fetchedAt: action.timestamp,
            scanId: action.scanId
          }
        }
      };
    }
    case 'SCAN_FINISH':
      if (state.scan.id !== action.scanId) return state;
      return { ...state, scan: { ...state.scan, status: action.status, completedAt: action.timestamp } };
    case 'LAYER_TOGGLE':
      return { ...state, layers: { ...state.layers, [action.layer]: !state.layers[action.layer] } };
    case 'LAYER_SET':
      return { ...state, layers: { ...state.layers, [action.layer]: action.value } };
    case 'AUTO_SCAN_SET':
      return { ...state, autoScan: action.value };
    case 'SELECT':
      return { ...state, selectionId: action.id };
    case 'LOG':
      return { ...state, logs: [action.entry, ...state.logs].slice(0, 100) };
    case 'CLEAR_LOGS':
      return { ...state, logs: [] };
    default:
      return state;
  }
}

export function allFeatures(state: RavenState): RavenFeature[] {
  const deduped = new Map<string, RavenFeature>();
  for (const run of Object.values(state.providers)) {
    for (const feature of run.features) deduped.set(feature.id, feature);
  }
  return Array.from(deduped.values());
}

export function visibleFeatures(state: RavenState): RavenFeature[] {
  return allFeatures(state).filter(feature => {
    if (feature.cameraType === 'speed') return state.layers.speedCameras;
    if (feature.mediaType === 'snapshot') return state.layers.snapshots;
    if (feature.mediaType === 'stream') return state.layers.streams;
    return state.layers.mappedCameras;
  });
}

export function providerSummary(state: RavenState) {
  const runs = Object.values(state.providers);
  return {
    ready: runs.filter(run => run.status === 'ready').length,
    loading: runs.filter(run => run.status === 'loading').length,
    error: runs.filter(run => run.status === 'error').length,
    skipped: runs.filter(run => run.status === 'skipped').length
  };
}

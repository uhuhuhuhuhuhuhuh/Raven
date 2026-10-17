import type { MapView } from './permalink';
import type { DataStatus, LayerKey, RavenBounds, RavenFeature, RavenMode, RavenPoint, RavenViewport } from './types';

/**
 * One data set on the map: the live-camera catalog or the OpenStreetMap cameras.
 * `features` holds what the contacts list and analytics work from: catalog records in
 * view, OSM points read back from the rendered vector tiles, or (without published
 * data) whatever the on-demand providers returned for `bounds`.
 */
export type DataSet = {
  status: DataStatus;
  /** Where the data comes from: published files, on-demand provider requests, or nothing yet. */
  source: 'catalog' | 'tiles' | 'providers' | 'none';
  features: RavenFeature[];
  /** Area the features cover (provider requests only). */
  bounds?: RavenBounds;
  /** When the published data was generated. */
  generatedAt?: string | null;
  warning?: string;
  error?: string;
};

export type RavenState = {
  mode: RavenMode;
  viewport: RavenViewport;
  /** Ranges and azimuths are measured from here: the map centre unless the user picked GPS. */
  referenceOrigin: RavenPoint & { source: 'map' | 'gps' };
  live: DataSet;
  osm: DataSet;
  layers: Record<LayerKey, boolean>;
  selectionId: string | null;
};

export type RavenAction =
  | { type: 'MODE_SET'; mode: RavenMode }
  | { type: 'VIEWPORT_CHANGED'; viewport: RavenViewport }
  | { type: 'REFERENCE_ORIGIN_SET'; point: RavenPoint; source: 'map' | 'gps' }
  | { type: 'DATA_SET'; set: 'live' | 'osm'; patch: Partial<DataSet> }
  | { type: 'LAYER_TOGGLE'; layer: LayerKey }
  | { type: 'LAYER_SET'; layer: LayerKey; value: boolean }
  | { type: 'SELECT'; id: string | null };

export const DEFAULT_VIEW: MapView = { lat: 25.7617, lon: -80.1918, zoom: 13.4 };

export const DEFAULT_LAYERS: Record<LayerKey, boolean> = {
  mappedCameras: true,
  snapshots: true,
  streams: true,
  speedCameras: true,
  alpr: true,
  heat: false,
  fov: true,
  rings: false,
  recent: true
};

export const LAYER_KEYS = Object.keys(DEFAULT_LAYERS) as LayerKey[];

const EMPTY_SET: DataSet = { status: 'idle', source: 'none', features: [] };

/** Rough bounds for a ~1024x768 view; replaced by the map's real bounds once it loads. */
function approximateBounds(view: MapView): RavenBounds {
  const degreesPerTile = 360 / 2 ** view.zoom;
  const halfWidth = 2 * degreesPerTile;
  const halfHeight = 1.5 * degreesPerTile * Math.cos(view.lat * Math.PI / 180);
  return { west: view.lon - halfWidth, south: view.lat - halfHeight, east: view.lon + halfWidth, north: view.lat + halfHeight };
}

export function createInitialState(view: MapView = DEFAULT_VIEW, layers: Partial<Record<LayerKey, boolean>> = {}): RavenState {
  const center = { lat: view.lat, lon: view.lon };
  return {
    mode: 'detecting',
    viewport: { center, bounds: approximateBounds(view), zoom: view.zoom },
    referenceOrigin: { ...center, source: 'map' },
    live: EMPTY_SET,
    osm: EMPTY_SET,
    layers: { ...DEFAULT_LAYERS, ...layers },
    selectionId: null
  };
}

export function hasSnapshot(feature: RavenFeature): boolean {
  return Boolean(feature.snapshotUrl);
}

export function hasStream(feature: RavenFeature): boolean {
  return Boolean(feature.streamUrl || feature.streamPageUrl);
}

export function ravenReducer(state: RavenState, action: RavenAction): RavenState {
  switch (action.type) {
    case 'MODE_SET':
      return { ...state, mode: action.mode };
    case 'VIEWPORT_CHANGED':
      return {
        ...state,
        viewport: action.viewport,
        referenceOrigin: state.referenceOrigin.source === 'map' ? { ...action.viewport.center, source: 'map' } : state.referenceOrigin
      };
    case 'REFERENCE_ORIGIN_SET':
      return { ...state, referenceOrigin: { ...action.point, source: action.source } };
    case 'DATA_SET':
      return { ...state, [action.set]: { ...state[action.set], ...action.patch } };
    case 'LAYER_TOGGLE':
      return { ...state, layers: { ...state.layers, [action.layer]: !state.layers[action.layer] } };
    case 'LAYER_SET':
      return { ...state, layers: { ...state.layers, [action.layer]: action.value } };
    case 'SELECT':
      return { ...state, selectionId: action.id };
    default:
      return state;
  }
}

/** Every loaded feature, live catalog first; an id appearing twice keeps its later record. */
export function allFeatures(state: RavenState): RavenFeature[] {
  const deduped = new Map<string, RavenFeature>();
  for (const feature of state.live.features) deduped.set(feature.id, feature);
  for (const feature of state.osm.features) deduped.set(feature.id, feature);
  return Array.from(deduped.values());
}

/** Whether `feature` passes the layer switches; data stays loaded while a layer is off. */
export function featureVisible(feature: RavenFeature, layers: Record<LayerKey, boolean>): boolean {
  if (feature.cameraType === 'speed') return layers.speedCameras;
  if (feature.cameraType === 'alpr') return layers.alpr;
  const snapshot = hasSnapshot(feature);
  const stream = hasStream(feature);
  if (stream && layers.streams) return true;
  if (snapshot && layers.snapshots) return true;
  if (stream || snapshot) return false;
  return layers.mappedCameras;
}

export function visibleFeatures(state: RavenState): RavenFeature[] {
  return allFeatures(state).filter(feature => featureVisible(feature, state.layers));
}

/** One line for the status pill, worst data set first. */
export function overallStatus(state: RavenState): DataStatus {
  const statuses = [state.live.status, state.osm.status];
  if (statuses.includes('loading')) return 'loading';
  if (statuses.every(status => status === 'error')) return 'error';
  if (statuses.includes('error') || statuses.includes('partial')) return 'partial';
  if (statuses.includes('ready')) return 'ready';
  return 'idle';
}

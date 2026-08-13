export type RavenMode = 'detecting' | 'static' | 'local';

export type CameraType = 'fixed' | 'dome' | 'ptz' | 'panorama' | 'alpr' | 'speed' | 'unknown';
export type MediaType = 'none' | 'snapshot' | 'stream' | 'external';
export type MediaHealth = 'unknown' | 'active' | 'stale' | 'offline';

export type RavenBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

export type RavenPoint = {
  lat: number;
  lon: number;
};

export type RavenViewport = {
  center: RavenPoint;
  bounds: RavenBounds;
  zoom: number;
};

export type RavenFeature = {
  id: string;
  providerId: string;
  sourceId?: string;
  kind: 'camera' | 'site';
  cameraType?: CameraType;
  mediaType: MediaType;
  mediaHealth?: MediaHealth;
  name?: string;
  lat: number;
  lon: number;
  address?: string;
  bearing?: number;
  directionLabel?: string;
  operator?: string;
  zone?: string;
  sourceUrl?: string;
  snapshotUrl?: string;
  streamUrl?: string;
  sourceUpdatedAt?: string;
  attribution?: string;
  fetchedAt: string;
  metadata: Record<string, unknown>;
};

export type ProviderRunStatus = 'idle' | 'loading' | 'ready' | 'error' | 'skipped';
export type ScanStatus = 'idle' | 'dirty' | 'scanning' | 'partial' | 'ready' | 'error';

export type ProviderRun = {
  providerId: string;
  status: ProviderRunStatus;
  features: RavenFeature[];
  error?: string;
  fetchedAt?: number;
  scanId?: string;
  pages?: number;
};

export type LayerKey = 'mappedCameras' | 'snapshots' | 'streams' | 'speedCameras' | 'heat' | 'scanOutline';

export type RavenLogEntry = {
  id: string;
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  channel: string;
  message: string;
};

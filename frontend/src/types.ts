export type RavenFeature = {
  id: string;
  providerId: string;
  sourceId?: string;
  kind: 'camera' | 'site' | 'live-feed';
  cameraType?: 'fixed' | 'dome' | 'ptz' | 'panorama' | 'alpr' | 'speed' | 'unknown';
  name?: string;
  lat: number;
  lon: number;
  address?: string;
  bearing?: number;
  operator?: string;
  zone?: string;
  sourceUrl?: string;
  attribution?: string;
  fetchedAt: string;
  metadata: Record<string, unknown>;
};

export type RavenMode = 'detecting' | 'static' | 'local';

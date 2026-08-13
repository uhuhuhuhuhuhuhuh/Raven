import type { RavenBounds, RavenFeature, RavenMode } from '../types';

export type ProviderCapability = 'mapped-camera' | 'snapshot' | 'stream' | 'camera-type' | 'direction' | 'operator';

export type ProviderScanRequest = {
  mode: RavenMode;
  bounds: RavenBounds;
};

export type ProviderScanResult = {
  features: RavenFeature[];
  pages?: number;
};

export type RavenProvider = {
  id: string;
  name: string;
  attribution: string;
  capabilities: ProviderCapability[];
  coverage?: RavenBounds;
  scan(request: ProviderScanRequest, signal: AbortSignal): Promise<ProviderScanResult>;
};

export function boundsIntersect(a: RavenBounds, b: RavenBounds): boolean {
  return !(a.east < b.west || a.west > b.east || a.north < b.south || a.south > b.north);
}

export function providerCovers(provider: RavenProvider, bounds: RavenBounds): boolean {
  return !provider.coverage || boundsIntersect(provider.coverage, bounds);
}

import type { ProviderProgress, RavenBounds, RavenFeature, RavenMode } from '../types';

export type ProviderCapability = 'mapped-camera' | 'snapshot' | 'stream' | 'camera-type' | 'direction' | 'operator';

export type ProviderScanRequest = {
  mode: RavenMode;
  bounds: RavenBounds;
  zoom: number;
  onProgress?: (features: RavenFeature[], progress: ProviderProgress) => void;
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
  minZoom?: number;
  cacheTtlMs?: number;
  scan(request: ProviderScanRequest, signal: AbortSignal): Promise<ProviderScanResult>;
};

export type ProviderEligibility = {
  active: boolean;
  reason?: string;
};

export function boundsIntersect(a: RavenBounds, b: RavenBounds): boolean {
  return !(a.east < b.west || a.west > b.east || a.north < b.south || a.south > b.north);
}

export function clipBounds(bounds: RavenBounds, coverage?: RavenBounds): RavenBounds | null {
  if (!coverage) return bounds;
  if (!boundsIntersect(bounds, coverage)) return null;
  return {
    west: Math.max(bounds.west, coverage.west),
    south: Math.max(bounds.south, coverage.south),
    east: Math.min(bounds.east, coverage.east),
    north: Math.min(bounds.north, coverage.north)
  };
}

export function providerEligibility(provider: RavenProvider, bounds: RavenBounds, zoom: number): ProviderEligibility {
  if (provider.coverage && !boundsIntersect(provider.coverage, bounds)) {
    return { active: false, reason: 'OUTSIDE COVERAGE' };
  }
  if (provider.minZoom !== undefined && zoom < provider.minZoom) {
    return { active: false, reason: `ZOOM IN TO z${provider.minZoom}+` };
  }
  return { active: true };
}

import type { RavenBounds } from '../types';
import { caltransProvider } from './caltrans';
import { fl511Provider } from './fl511';
import { osmProvider } from './osm';
import { providerEligibility, type RavenProvider } from './types';

export const ravenProviders: RavenProvider[] = [osmProvider, fl511Provider, caltransProvider];

export function providerPlan(bounds: RavenBounds, zoom: number): {
  active: RavenProvider[];
  skipped: Record<string, string>;
} {
  const active: RavenProvider[] = [];
  const skipped: Record<string, string> = {};
  for (const provider of ravenProviders) {
    const eligibility = providerEligibility(provider, bounds, zoom);
    if (eligibility.active) active.push(provider);
    else skipped[provider.id] = eligibility.reason || 'UNAVAILABLE';
  }
  return { active, skipped };
}

export function providerById(id: string): RavenProvider | undefined {
  return ravenProviders.find(provider => provider.id === id);
}

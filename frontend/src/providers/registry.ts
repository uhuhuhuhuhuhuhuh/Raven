import type { RavenBounds } from '../types';
import { fl511Provider } from './fl511';
import { osmProvider } from './osm';
import { providerCovers, type RavenProvider } from './types';

export const ravenProviders: RavenProvider[] = [osmProvider, fl511Provider];

export function activeProviders(bounds: RavenBounds): RavenProvider[] {
  return ravenProviders.filter(provider => providerCovers(provider, bounds));
}

export function providerById(id: string): RavenProvider | undefined {
  return ravenProviders.find(provider => provider.id === id);
}

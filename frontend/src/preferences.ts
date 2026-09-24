import type { LayerKey } from './types';

const STORAGE_KEY = 'raven.preferences.v1';

export type RavenPreferences = {
  layers?: Partial<Record<LayerKey, boolean>>;
  autoScan?: boolean;
};

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): KeyValueStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Reads saved layer/auto-scan choices. Storage can be missing, blocked or hold stale
 * shapes, so only known layer keys with boolean values survive.
 */
export function loadPreferences(knownLayers: readonly LayerKey[], storage = defaultStorage()): RavenPreferences {
  try {
    const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) || '{}');
    const layers: Partial<Record<LayerKey, boolean>> = {};
    for (const key of knownLayers) {
      if (typeof parsed?.layers?.[key] === 'boolean') layers[key] = parsed.layers[key];
    }
    return { layers, autoScan: typeof parsed?.autoScan === 'boolean' ? parsed.autoScan : undefined };
  } catch {
    return {};
  }
}

export function savePreferences(preferences: RavenPreferences, storage = defaultStorage()): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Preferences are a convenience; quota or privacy-mode failures are ignored.
  }
}

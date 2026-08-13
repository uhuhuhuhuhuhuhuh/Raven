import type { RavenBounds, RavenFeature } from './types';

const DB_NAME = 'raven-provider-cache';
const STORE = 'providerScans';
const VERSION = 1;
const memoryFallback = new Map<string, CachedProviderScan>();

export type CachedProviderScan = {
  key: string;
  providerId: string;
  bounds: RavenBounds;
  features: RavenFeature[];
  pages?: number;
  savedAt: number;
};

function rounded(value: number): string {
  return value.toFixed(4);
}

export function providerCacheKey(providerId: string, bounds: RavenBounds): string {
  return [providerId, rounded(bounds.west), rounded(bounds.south), rounded(bounds.east), rounded(bounds.north)].join(':');
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
  });
}

export async function getCachedProviderScan(providerId: string, bounds: RavenBounds, maxAgeMs: number): Promise<CachedProviderScan | null> {
  const key = providerCacheKey(providerId, bounds);
  try {
    const database = await openDatabase();
    if (!database) {
      const record = memoryFallback.get(key);
      return record && Date.now() - record.savedAt <= maxAgeMs ? record : null;
    }
    const record = await new Promise<CachedProviderScan | undefined>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readonly');
      const request = transaction.objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result as CachedProviderScan | undefined);
      request.onerror = () => reject(request.error || new Error('IndexedDB read failed'));
    });
    database.close();
    if (!record || Date.now() - record.savedAt > maxAgeMs) return null;
    return record;
  } catch {
    const record = memoryFallback.get(key);
    return record && Date.now() - record.savedAt <= maxAgeMs ? record : null;
  }
}

export async function putCachedProviderScan(providerId: string, bounds: RavenBounds, features: RavenFeature[], pages?: number): Promise<void> {
  const record: CachedProviderScan = {
    key: providerCacheKey(providerId, bounds),
    providerId,
    bounds,
    features,
    pages,
    savedAt: Date.now()
  };
  memoryFallback.set(record.key, record);
  try {
    const database = await openDatabase();
    if (!database) return;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB write failed'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB write aborted'));
    });
    database.close();
  } catch {
    // The in-memory fallback already contains the record. Cache failure must never fail a scan.
  }
}

export async function clearProviderCache(): Promise<void> {
  memoryFallback.clear();
  try {
    const database = await openDatabase();
    if (!database) return;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB clear failed'));
    });
    database.close();
  } catch {
    // Cache clearing is best-effort when browser storage is unavailable.
  }
}

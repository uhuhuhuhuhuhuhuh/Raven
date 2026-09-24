import type { RavenBounds, RavenFeature } from './types';

const DB_NAME = 'raven-provider-cache';
const STORE = 'providerScans';
const SAVED_AT_INDEX = 'savedAt';
const VERSION = 2;
// Entries outlive every provider TTL by a wide margin; anything older can never be served.
const MAX_ENTRY_AGE_MS = 60 * 60 * 1000;
const MAX_STORED_ENTRIES = 200;
// The in-memory copy holds full feature arrays, so keep it much smaller than the disk store.
const MAX_MEMORY_ENTRIES = 24;
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

export type CacheEntryStamp = { key: string; savedAt: number };

/** Keys to evict: every entry past `maxAgeMs`, then the oldest survivors beyond `maxEntries`. */
export function selectEvictions(entries: CacheEntryStamp[], now: number, maxAgeMs: number, maxEntries: number): string[] {
  const expired = entries.filter(entry => now - entry.savedAt > maxAgeMs);
  const live = entries.filter(entry => now - entry.savedAt <= maxAgeMs).sort((a, b) => a.savedAt - b.savedAt);
  const overflow = live.slice(0, Math.max(0, live.length - maxEntries));
  return [...expired, ...overflow].map(entry => entry.key);
}

function pruneMemory(now: number) {
  const stamps = Array.from(memoryFallback.values(), record => ({ key: record.key, savedAt: record.savedAt }));
  for (const key of selectEvictions(stamps, now, MAX_ENTRY_AGE_MS, MAX_MEMORY_ENTRIES)) memoryFallback.delete(key);
}

/** Walks the savedAt index (keys only, no feature payloads) and deletes evicted entries. */
function pruneStore(store: IDBObjectStore, now: number) {
  const stamps: CacheEntryStamp[] = [];
  const cursorRequest = store.index(SAVED_AT_INDEX).openKeyCursor();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (cursor) {
      stamps.push({ key: String(cursor.primaryKey), savedAt: Number(cursor.key) });
      cursor.continue();
      return;
    }
    for (const key of selectEvictions(stamps, now, MAX_ENTRY_AGE_MS, MAX_STORED_ENTRIES)) store.delete(key);
  };
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
      // v1 databases already have the store; v2 adds the savedAt index used for pruning.
      const store = database.objectStoreNames.contains(STORE)
        ? request.transaction!.objectStore(STORE)
        : database.createObjectStore(STORE, { keyPath: 'key' });
      if (!store.indexNames.contains(SAVED_AT_INDEX)) store.createIndex(SAVED_AT_INDEX, 'savedAt');
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
  pruneMemory(record.savedAt);
  try {
    const database = await openDatabase();
    if (!database) return;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      store.put(record);
      pruneStore(store, record.savedAt);
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

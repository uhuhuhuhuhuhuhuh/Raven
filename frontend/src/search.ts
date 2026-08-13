import type { RavenMode } from './types';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const cache = new Map<string, { lat: number; lon: number; label: string } | null>();
let lastPublicRequest = 0;

function parseCoordinates(query: string): { lat: number; lon: number; label: string } | null {
  const match = query.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon, label: `${lat.toFixed(6)}, ${lon.toFixed(6)}` };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Search aborted', 'AbortError'));
    }, { once: true });
  });
}

export async function searchPlace(mode: RavenMode, query: string, signal?: AbortSignal): Promise<{ lat: number; lon: number; label: string } | null> {
  const coordinates = parseCoordinates(query);
  if (coordinates) return coordinates;

  const key = query.trim().toLowerCase();
  if (cache.has(key)) return cache.get(key) ?? null;

  if (mode === 'local') {
    const params = new URLSearchParams({ q: query.trim() });
    const response = await fetch(`/api/search?${params.toString()}`, { signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Local search failed (${response.status})`);
    const result = await response.json();
    const normalized = result?.result || null;
    cache.set(key, normalized);
    return normalized;
  }

  const elapsed = Date.now() - lastPublicRequest;
  if (elapsed < 1000) await sleep(1000 - elapsed, signal);
  lastPublicRequest = Date.now();

  const url = new URL(NOMINATIM);
  url.searchParams.set('q', query.trim());
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  const response = await fetch(url, {
    signal,
    headers: { Accept: 'application/json', 'Accept-Language': navigator.language || 'en' }
  });
  if (!response.ok) throw new Error(`Search failed (${response.status})`);
  const results = await response.json();
  const normalized = results?.length
    ? { lat: Number(results[0].lat), lon: Number(results[0].lon), label: String(results[0].display_name) }
    : null;
  cache.set(key, normalized);
  return normalized;
}

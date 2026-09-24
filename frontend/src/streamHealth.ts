import type { RavenFeature } from './types';

export type StreamHealth = { checkedAt: string; online: Map<string, boolean> };

/** A stream counts as online when its URL answers with an HLS playlist (or, for progressive video, any 2xx). */
export async function probeStream(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return false;
    if (!/\.m3u8(?:[?#].*)?$/i.test(url)) return true;
    return (await response.text()).trimStart().startsWith('#EXTM3U');
  } catch {
    return false;
  }
}

/**
 * Checks each published stream URL once, a few at a time, so the daily build is a light
 * load on the agencies' streaming servers. About a third of published streams never
 * answer (live ones reply well within the timeout), so waiting is cheap to parallelise, and an overall budget bounds the build: streams not
 * reached within it are left unmarked rather than reported offline.
 */
export async function checkStreams(
  features: RavenFeature[],
  { concurrency = 24, timeoutMs = 5000, budgetMs = 300_000 } = {}
): Promise<StreamHealth> {
  const streams = features.filter(feature => feature.streamUrl);
  const online = new Map<string, boolean>();
  const deadline = Date.now() + budgetMs;
  let next = 0;
  async function worker() {
    while (next < streams.length && Date.now() < deadline) {
      const feature = streams[next];
      next += 1;
      online.set(feature.id, await probeStream(feature.streamUrl!, timeoutMs));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, streams.length) }, worker));
  return { checkedAt: new Date().toISOString(), online };
}

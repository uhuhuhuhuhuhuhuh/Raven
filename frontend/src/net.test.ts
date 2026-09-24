import { afterEach, describe, expect, it, vi } from 'vitest';
import { isHlsUrl } from './components/LiveVideo';
import { fetchWithRetry, retryDelayMs, sleep } from './net';

afterEach(() => vi.unstubAllGlobals());

function status(code: number, headers: Record<string, string> = {}) {
  return new Response('{}', { status: code, headers });
}

describe('polite network retry', () => {
  it('prefers a numeric Retry-After, otherwise backs off exponentially, always capped', () => {
    expect(retryDelayMs(status(429, { 'Retry-After': '3' }), 0)).toBe(3000);
    expect(retryDelayMs(status(503), 0, 1000)).toBe(1000);
    expect(retryDelayMs(status(503), 2, 1000)).toBe(4000);
    expect(retryDelayMs(status(429, { 'Retry-After': '600' }), 0, 1000, 30_000)).toBe(30_000);
  });

  it('retries rate-limited responses and returns the eventual success', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(status(429, { 'Retry-After': '0' }))
      .mockResolvedValueOnce(status(504, { 'Retry-After': '0' }))
      .mockResolvedValueOnce(status(200));
    vi.stubGlobal('fetch', fetchSpy);
    const response = await fetchWithRetry('https://example.test/', {});
    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('gives up after the retry budget and does not retry client errors', async () => {
    const overloaded = vi.fn(async () => status(503, { 'Retry-After': '0' }));
    vi.stubGlobal('fetch', overloaded);
    expect((await fetchWithRetry('https://example.test/', {}, { retries: 2 })).status).toBe(503);
    expect(overloaded).toHaveBeenCalledTimes(3);

    const badRequest = vi.fn(async () => status(400));
    vi.stubGlobal('fetch', badRequest);
    expect((await fetchWithRetry('https://example.test/', {})).status).toBe(400);
    expect(badRequest).toHaveBeenCalledTimes(1);
  });

  it('stops waiting as soon as the scan is aborted', async () => {
    const controller = new AbortController();
    const waiting = sleep(60_000, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await expect(sleep(10, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('stream URL classification', () => {
  it('recognises HLS playlists, including ones with query strings', () => {
    expect(isHlsUrl('https://wzmedia.dot.ca.gov/D3/cam.stream/playlist.m3u8')).toBe(true);
    expect(isHlsUrl('https://example.test/live.M3U8?token=public')).toBe(true);
    expect(isHlsUrl('https://example.test/clip.mp4')).toBe(false);
    expect(isHlsUrl('https://cwwp2.dot.ca.gov/vm/loc/d7/viewer.htm')).toBe(false);
  });
});

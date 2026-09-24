import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildStaticApi } from './staticApi';
import { checkStreams, probeStream } from './streamHealth';
import type { RavenFeature } from './types';

afterEach(() => vi.unstubAllGlobals());

function camera(id: string, streamUrl?: string): RavenFeature {
  return { id, providerId: 'caltrans-cctv', kind: 'camera', mediaType: streamUrl ? 'stream' : 'snapshot', name: id, lat: 38, lon: -121, streamUrl, fetchedAt: '', metadata: {} };
}

describe('stream health checks', () => {
  it('only counts a playlist that answers with #EXTM3U as online', async () => {
    const responses: Record<string, () => Response> = {
      'https://s.test/live.m3u8': () => new Response('#EXTM3U\n#EXT-X-VERSION:3\n'),
      'https://s.test/html.m3u8': () => new Response('<html>maintenance</html>'),
      'https://s.test/gone.m3u8': () => new Response('missing', { status: 404 }),
      'https://s.test/clip.mp4': () => new Response('binary')
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://s.test/down.m3u8') throw new TypeError('connection refused');
      return responses[url]();
    }));
    expect(await probeStream('https://s.test/live.m3u8', 1000)).toBe(true);
    expect(await probeStream('https://s.test/html.m3u8', 1000)).toBe(false);
    expect(await probeStream('https://s.test/gone.m3u8', 1000)).toBe(false);
    expect(await probeStream('https://s.test/down.m3u8', 1000)).toBe(false);
    expect(await probeStream('https://s.test/clip.mp4', 1000)).toBe(true);
  });

  it('checks each stream once with bounded concurrency and records results in the API', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchSpy = vi.fn(async (url: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Response(url.includes('dead') ? 'nope' : '#EXTM3U', { status: url.includes('dead') ? 503 : 200 });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const features = [
      ...Array.from({ length: 10 }, (_, index) => camera(`caltrans-${index}`, `https://s.test/${index}.m3u8`)),
      camera('caltrans-dead', 'https://s.test/dead.m3u8'),
      camera('caltrans-still')
    ];
    const health = await checkStreams(features, { concurrency: 3, timeoutMs: 1000 });
    expect(fetchSpy).toHaveBeenCalledTimes(11);
    expect(peak).toBeLessThanOrEqual(3);
    expect(health.online.get('caltrans-dead')).toBe(false);
    expect(health.online.get('caltrans-3')).toBe(true);

    const files = buildStaticApi([{ id: 'caltrans-cctv', name: 'Caltrans', attribution: 'Caltrans', features }], '2026-09-24T00:00:00Z', {}, health);
    expect(files['streams.json'].healthCheckedAt).toBe(health.checkedAt);
    expect(files['streams.json'].streams.find(stream => stream.id === 'caltrans-dead')?.stream).toEqual({ url: 'https://s.test/dead.m3u8', format: 'hls', online: false });
    expect(files['index.json'].providers[0]).toMatchObject({ streams: 11, streamsOnline: 10 });
  });

  it('leaves streams unmarked once the time budget is spent', async () => {
    const fetchSpy = vi.fn(async () => new Response('#EXTM3U'));
    vi.stubGlobal('fetch', fetchSpy);
    const health = await checkStreams([camera('caltrans-1', 'https://s.test/1.m3u8')], { budgetMs: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(health.online.size).toBe(0);
    const files = buildStaticApi([{ id: 'caltrans-cctv', name: 'Caltrans', attribution: 'Caltrans', features: [camera('caltrans-1', 'https://s.test/1.m3u8')] }], 'now', {}, health);
    expect(files['streams.json'].streams[0].stream).toEqual({ url: 'https://s.test/1.m3u8', format: 'hls' });
  });
});


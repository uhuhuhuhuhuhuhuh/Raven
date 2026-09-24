import { afterEach, describe, expect, it, vi } from 'vitest';
import { FALLBACK_BASEMAP, loadBasemap, OPENFREEMAP_STYLE_URL, tintStyle } from './basemap';

afterEach(() => vi.unstubAllGlobals());

const style = {
  version: 8 as const,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {},
  layers: [
    { id: 'background', type: 'background' as const, paint: { 'background-color': 'rgb(12,12,12)' } },
    { id: 'water', type: 'fill' as const, source: 'openmaptiles', paint: { 'fill-color': 'rgb(27,27,29)', 'fill-antialias': false } },
    { id: 'roads', type: 'line' as const, source: 'openmaptiles', paint: { 'line-color': '#333' } }
  ]
};

describe('basemap', () => {
  it('tints only the background and water to the Raven palette', () => {
    const tinted = tintStyle(style);
    expect(tinted.layers[0]).toMatchObject({ paint: { 'background-color': '#07100d' } });
    expect(tinted.layers[1]).toMatchObject({ paint: { 'fill-color': '#0b1a16', 'fill-antialias': false } });
    expect(tinted.layers[2]).toBe(style.layers[2]);
  });

  it('uses the OpenFreeMap vector style with its own glyph fonts when it loads', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(style), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const basemap = await loadBasemap();
    expect(fetchSpy).toHaveBeenCalledWith(OPENFREEMAP_STYLE_URL, expect.anything());
    expect(basemap.source).toBe('openfreemap');
    expect(basemap.textFont).toEqual(['Noto Sans Bold']);
    expect(basemap.style.glyphs).toBe(style.glyphs);
  });

  it.each([
    ['an HTTP error', () => new Response('down', { status: 503 })],
    ['a non-style document', () => new Response('{"hello":"world"}', { status: 200 })],
    ['a network failure', () => { throw new TypeError('network down'); }]
  ])('falls back to the raster style on %s, so the map still starts', async (_label, respond) => {
    vi.stubGlobal('fetch', vi.fn(async () => respond()));
    expect(await loadBasemap()).toBe(FALLBACK_BASEMAP);
  });
});

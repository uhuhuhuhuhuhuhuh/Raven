import { describe, expect, it } from 'vitest';
import { isHlsUrl, parseBearing, parseViewingDirection, publicHttpsUrl } from './normalize';

describe('provider field normalization', () => {
  it('accepts only https or protocol-relative media URLs', () => {
    expect(publicHttpsUrl(' https://example.test/a.jpg ')).toBe('https://example.test/a.jpg');
    expect(publicHttpsUrl('//example.test/a.jpg')).toBe('https://example.test/a.jpg');
    expect(publicHttpsUrl('http://example.test/a.jpg')).toBeUndefined();
    expect(publicHttpsUrl('')).toBeUndefined();
    expect(publicHttpsUrl(42)).toBeUndefined();
  });

  it('parses numeric bearings and normalises them into [0, 360)', () => {
    expect(parseBearing('45')).toBe(45);
    expect(parseBearing('270°')).toBe(270);
    expect(parseBearing(-90)).toBe(270);
    expect(parseBearing('')).toBeUndefined();
    expect(parseBearing('NORTHBOUND')).toBeUndefined();
  });

  it('reads OSM compass viewing directions but not roadway labels', () => {
    expect(parseViewingDirection('NE')).toBe(45);
    expect(parseViewingDirection('ssw')).toBe(202.5);
    expect(parseViewingDirection('120')).toBe(120);
    expect(parseViewingDirection('NORTHBOUND')).toBeUndefined();
    expect(parseViewingDirection('45;135')).toBeUndefined();
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

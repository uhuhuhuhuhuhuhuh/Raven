export function publicHttpsUrl(value?: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith('https://')) return trimmed;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  return undefined;
}

export function isHlsUrl(url: string): boolean {
  return /\.m3u8(?:[?#].*)?$/i.test(url);
}

/** Numeric bearing in degrees ("45", "45°", 45), normalised into [0, 360). */
export function parseBearing(value?: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).replace('°', '').trim();
  if (!text) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? ((parsed % 360) + 360) % 360 : undefined;
}

const COMPASS_POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/**
 * OSM `direction` / `camera:direction` values may be degrees or a 16-point compass
 * abbreviation ("NE", "SSW"). Only use this where the tag is defined as the camera's
 * viewing direction; a roadway "NORTHBOUND" label is not a facing.
 */
export function parseViewingDirection(value?: unknown): number | undefined {
  const numeric = parseBearing(value);
  if (numeric !== undefined) return numeric;
  if (typeof value !== 'string') return undefined;
  const index = COMPASS_POINTS.indexOf(value.trim().toUpperCase());
  return index === -1 ? undefined : index * 22.5;
}

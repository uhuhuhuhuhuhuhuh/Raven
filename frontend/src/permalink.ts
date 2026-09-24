export type MapView = { lat: number; lon: number; zoom: number };

/** Parses an OSM-style `#map=zoom/lat/lon` fragment; null when absent or out of range. */
export function parseViewHash(hash: string): MapView | null {
  const match = hash.match(/(?:^#|&)map=(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)(?:&|$)/);
  if (!match) return null;
  const [zoom, lat, lon] = match.slice(1).map(Number);
  if (zoom < 0 || zoom > 22 || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon, zoom };
}

export function formatViewHash(view: MapView): string {
  return `#map=${view.zoom.toFixed(2)}/${view.lat.toFixed(5)}/${view.lon.toFixed(5)}`;
}

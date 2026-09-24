import type { RavenFeature, RavenPoint } from './types';

/** The OpenStreetMap editor for an OSM-sourced record, e.g. osm-node-42 -> edit?node=42. */
export function osmEditUrl(feature: RavenFeature): string | undefined {
  const match = /^osm-(node|way|relation)-(\d+)$/.exec(feature.id);
  return match ? `https://www.openstreetmap.org/edit?${match[1]}=${match[2]}` : undefined;
}

/** The OpenStreetMap editor zoomed in on `point`, for mapping a camera Raven does not show yet. */
export function osmAddUrl(point: RavenPoint, zoom = 19): string {
  return `https://www.openstreetmap.org/edit#map=${zoom}/${point.lat.toFixed(5)}/${point.lon.toFixed(5)}`;
}

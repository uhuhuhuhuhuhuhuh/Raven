import { hasSnapshot, hasStream } from './state';
import type { LayerKey, RavenFeature } from './types';

/**
 * Camera marker classes. On a map any two markers can sit side by side, so the
 * palette was validated all-pairs (dataviz validator, dark mode, map and panel
 * surfaces): only three hues clear every colour-vision gate, so shape is the second
 * channel. Blue = public media, orange = plate readers, aqua = mapped cameras.
 */
export const HUES = {
  media: '#3987e5',
  alpr: '#d95926',
  mapped: '#199e70'
} as const;

export type MarkerShape = 'dot' | 'ring' | 'diamond' | 'square' | 'circle';
export type MarkerKey = 'stream' | 'snapshot' | 'alpr' | 'speed' | 'mapped';

export type MarkerClass = { key: MarkerKey; label: string; color: string; shape: MarkerShape; layer: LayerKey };

/** Fixed order: legend, analytics and layer panel all list classes this way. */
export const MARKER_CLASSES: MarkerClass[] = [
  { key: 'stream', label: 'Live stream', color: HUES.media, shape: 'ring', layer: 'streams' },
  { key: 'snapshot', label: 'Snapshot', color: HUES.media, shape: 'dot', layer: 'snapshots' },
  { key: 'alpr', label: 'Plate reader', color: HUES.alpr, shape: 'diamond', layer: 'alpr' },
  { key: 'speed', label: 'Speed camera', color: HUES.mapped, shape: 'square', layer: 'speedCameras' },
  { key: 'mapped', label: 'Mapped camera', color: HUES.mapped, shape: 'circle', layer: 'mappedCameras' }
];

export const MARKER_BY_KEY = Object.fromEntries(MARKER_CLASSES.map(item => [item.key, item])) as Record<MarkerKey, MarkerClass>;

export function markerKey(feature: RavenFeature): MarkerKey {
  if (hasStream(feature)) return 'stream';
  if (hasSnapshot(feature)) return 'snapshot';
  if (feature.cameraType === 'alpr') return 'alpr';
  if (feature.cameraType === 'speed') return 'speed';
  return 'mapped';
}

/** Surface colour drawn around every marker so overlapping markers stay separable. */
const MARKER_RING = '#0a0e15';

/** Traces a marker shape centred at (c, c) with half-size r into the current path. */
export function traceShape(context: CanvasRenderingContext2D, shape: MarkerShape, c: number, r: number) {
  context.beginPath();
  if (shape === 'diamond') {
    context.moveTo(c, c - r * 1.25);
    context.lineTo(c + r * 1.25, c);
    context.lineTo(c, c + r * 1.25);
    context.lineTo(c - r * 1.25, c);
    context.closePath();
  } else if (shape === 'square') {
    context.roundRect(c - r * 0.95, c - r * 0.95, r * 1.9, r * 1.9, r * 0.3);
  } else {
    context.arc(c, c, r, 0, Math.PI * 2);
  }
}

/** RGBA bitmap for MapLibre's addImage: the class shape in its hue, ringed in the surface colour. */
export function markerBitmap(item: MarkerClass, pixelRatio = 2): { width: number; height: number; data: Uint8ClampedArray } {
  const size = 24 * pixelRatio;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d')!;
  const c = size / 2;
  const r = (item.shape === 'ring' ? 5 : item.shape === 'dot' ? 5.5 : 6) * pixelRatio;

  context.lineJoin = 'round';
  traceShape(context, item.shape, c, r);
  context.lineWidth = 3 * pixelRatio;
  context.strokeStyle = MARKER_RING;
  context.stroke();
  context.fillStyle = item.color;
  context.fill();
  if (item.shape === 'ring') {
    // A live stream is the media dot plus an outer ring.
    context.beginPath();
    context.arc(c, c, r + 3.5 * pixelRatio, 0, Math.PI * 2);
    context.lineWidth = 3.5 * pixelRatio;
    context.strokeStyle = MARKER_RING;
    context.stroke();
    context.lineWidth = 1.75 * pixelRatio;
    context.strokeStyle = item.color;
    context.stroke();
  }
  return { width: size, height: size, data: context.getImageData(0, 0, size, size).data };
}

/** Compact tag for list rows: the class, or the mapped camera's type when OSM records it. */
export function markerTag(feature: RavenFeature): string {
  const key = markerKey(feature);
  if (key === 'stream') return 'Live';
  if (key === 'snapshot') return 'Snapshot';
  if (key === 'alpr') return 'ALPR';
  if (key === 'speed') return 'Speed';
  const type = feature.cameraType && feature.cameraType !== 'unknown' ? feature.cameraType : 'mapped';
  return type === 'ptz' ? 'PTZ' : type[0].toUpperCase() + type.slice(1);
}

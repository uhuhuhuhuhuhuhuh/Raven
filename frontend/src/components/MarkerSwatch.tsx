import type { MarkerClass } from '../markers';

/** The map marker's shape and hue as a small inline legend glyph. */
export function MarkerSwatch({ marker, size = 14 }: { marker: MarkerClass; size?: number }) {
  const c = 7;
  const r = 4;
  const fill = marker.color;
  return (
    <svg className="marker-swatch" width={size} height={size} viewBox="0 0 14 14" aria-hidden="true">
      {marker.shape === 'diamond' && <path d={`M${c} ${c - 5}L${c + 5} ${c}L${c} ${c + 5}L${c - 5} ${c}Z`} fill={fill} />}
      {marker.shape === 'square' && <rect x={c - 4} y={c - 4} width={8} height={8} rx={1.4} fill={fill} />}
      {(marker.shape === 'circle' || marker.shape === 'dot') && <circle cx={c} cy={c} r={r} fill={fill} />}
      {marker.shape === 'ring' && (
        <>
          <circle cx={c} cy={c} r={3} fill={fill} />
          <circle cx={c} cy={c} r={5.6} fill="none" stroke={fill} strokeWidth={1.4} />
        </>
      )}
    </svg>
  );
}

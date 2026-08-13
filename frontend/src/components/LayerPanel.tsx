import type { LayerKey } from '../types';

const LAYERS: Array<{ key: LayerKey; label: string; group: 'CAMERAS' | 'OVERLAYS'; hint: string }> = [
  { key: 'mappedCameras', label: 'MAPPED CAMERAS', group: 'CAMERAS', hint: 'OSM surveillance records' },
  { key: 'snapshots', label: 'TRAFFIC SNAPSHOTS', group: 'CAMERAS', hint: 'Refreshing public images' },
  { key: 'streams', label: 'VIDEO STREAMS', group: 'CAMERAS', hint: 'Continuous public video' },
  { key: 'speedCameras', label: 'SPEED CAMERAS', group: 'CAMERAS', hint: 'Mapped speed-camera records' },
  { key: 'heat', label: 'HEATMAP', group: 'OVERLAYS', hint: 'Visible-contact density' },
  { key: 'scanOutline', label: 'SCAN OUTLINE', group: 'OVERLAYS', hint: 'Last queried viewport' }
];

export function LayerPanel({
  layers,
  autoScan,
  onToggle,
  onAutoScan
}: {
  layers: Record<LayerKey, boolean>;
  autoScan: boolean;
  onToggle: (layer: LayerKey) => void;
  onAutoScan: (value: boolean) => void;
}) {
  return (
    <section className="layer-panel analytics-card">
      <div className="section-label">LAYER CONTROL</div>
      {(['CAMERAS', 'OVERLAYS'] as const).map(group => (
        <div key={group} className="layer-group">
          <div className="layer-group-title">{group}</div>
          {LAYERS.filter(layer => layer.group === group).map(layer => (
            <button
              key={layer.key}
              className={`layer-toggle ${layers[layer.key] ? 'on' : ''}`}
              aria-pressed={layers[layer.key]}
              onClick={() => onToggle(layer.key)}
            >
              <span><strong>{layer.label}</strong><small>{layer.hint}</small></span>
              <b>{layers[layer.key] ? 'ON' : 'OFF'}</b>
            </button>
          ))}
        </div>
      ))}
      <div className="layer-group">
        <div className="layer-group-title">SCANNING</div>
        <button className={`layer-toggle ${autoScan ? 'on' : ''}`} aria-pressed={autoScan} onClick={() => onAutoScan(!autoScan)}>
          <span><strong>AUTO SCAN</strong><small>Debounced after map movement</small></span>
          <b>{autoScan ? 'ON' : 'OFF'}</b>
        </button>
      </div>
    </section>
  );
}

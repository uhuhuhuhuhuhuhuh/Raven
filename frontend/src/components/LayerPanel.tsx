import type { ReactNode } from 'react';
import { MARKER_CLASSES } from '../markers';
import type { LayerKey } from '../types';
import { MarkerSwatch } from './MarkerSwatch';

const CAMERA_HINTS: Partial<Record<LayerKey, string>> = {
  streams: 'Continuous public video',
  snapshots: 'Refreshing public images',
  alpr: 'OSM surveillance:type=ALPR',
  speedCameras: 'Mapped speed-camera records',
  mappedCameras: 'OSM surveillance records'
};

const OVERLAYS: Array<{ key: LayerKey; label: string; hint: string }> = [
  { key: 'fov', label: 'Field of view', hint: 'Approx. facing where tagged · z15+' },
  { key: 'recent', label: 'Newly mapped', hint: 'Added to OSM since the last weekly extract' },
  { key: 'heat', label: 'Heatmap', hint: 'Visible-contact density' },
  { key: 'rings', label: 'Range rings', hint: 'Distance from reference origin' },
  { key: 'scanOutline', label: 'Scan outline', hint: 'Last queried viewport' }
];

function Switch({ label, hint, checked, onChange, swatch }: { label: string; hint: string; checked: boolean; onChange: () => void; swatch?: ReactNode }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="switch-row" onClick={onChange}>
      {swatch && <span className="switch-swatch">{swatch}</span>}
      <span className="switch-text"><strong>{label}</strong><small>{hint}</small></span>
      <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
    </button>
  );
}

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
    <div className="layer-panel">
      <section className="card">
        <h3 className="eyebrow">Cameras</h3>
        {MARKER_CLASSES.map(marker => (
          <Switch
            key={marker.layer}
            label={marker.label}
            hint={CAMERA_HINTS[marker.layer] || ''}
            checked={layers[marker.layer]}
            onChange={() => onToggle(marker.layer)}
            swatch={<MarkerSwatch marker={marker} />}
          />
        ))}
      </section>
      <section className="card">
        <h3 className="eyebrow">Overlays</h3>
        {OVERLAYS.map(layer => (
          <Switch key={layer.key} label={layer.label} hint={layer.hint} checked={layers[layer.key]} onChange={() => onToggle(layer.key)} />
        ))}
      </section>
      <section className="card">
        <h3 className="eyebrow">Scanning</h3>
        <Switch label="Auto scan" hint="Rescan shortly after the map stops moving" checked={autoScan} onChange={() => onAutoScan(!autoScan)} />
      </section>
    </div>
  );
}

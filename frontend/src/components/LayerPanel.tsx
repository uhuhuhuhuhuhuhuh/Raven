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
  { key: 'heat', label: 'Heatmap', hint: 'Camera density' },
  { key: 'rings', label: 'Range rings', hint: 'Distance from the reference point' }
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

export function LayerPanel({ layers, onToggle }: { layers: Record<LayerKey, boolean>; onToggle: (layer: LayerKey) => void }) {
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
    </div>
  );
}

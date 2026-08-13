import type { RavenFeature } from '../types';
import { SnapshotViewer } from './SnapshotViewer';

export function CameraViewer({ feature }: { feature: RavenFeature }) {
  if (feature.mediaType === 'snapshot') return <SnapshotViewer feature={feature} />;

  if (feature.mediaType === 'stream' && feature.streamUrl) {
    return (
      <section className="stream-viewer">
        <div className="media-status media-active"><span>● STREAM</span><span>PUBLIC SOURCE</span></div>
        <video src={feature.streamUrl} controls autoPlay muted playsInline />
        <div className="media-note">Playback depends on the public source format and browser codec support.</div>
      </section>
    );
  }

  return (
    <div className="media-empty">
      {feature.mediaType === 'external' ? 'PUBLIC CAMERA PAGE AVAILABLE · NO EMBEDDABLE MEDIA' : 'NO PUBLIC MEDIA FOR THIS MAPPED CAMERA'}
    </div>
  );
}

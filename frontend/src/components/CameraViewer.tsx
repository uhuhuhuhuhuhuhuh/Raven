import type { RavenFeature } from '../types';
import { SnapshotViewer } from './SnapshotViewer';

export function CameraViewer({ feature }: { feature: RavenFeature }) {
  if (feature.streamUrl) {
    return (
      <section className="stream-viewer">
        <div className="media-status media-active"><span>● STREAM</span><span>PUBLIC DIRECT MEDIA</span></div>
        <video src={feature.streamUrl} controls autoPlay muted playsInline />
        <div className="media-note">Direct public video. Playback depends on browser codec support.</div>
        {feature.snapshotUrl && <details className="media-fallback"><summary>SHOW SNAPSHOT FALLBACK</summary><SnapshotViewer feature={feature} /></details>}
      </section>
    );
  }

  if (feature.streamPageUrl) {
    return (
      <section className="stream-viewer external-stream">
        <div className="media-status media-active"><span>● LIVE STREAM AVAILABLE</span><span>OFFICIAL VIEWER</span></div>
        {feature.snapshotUrl ? <SnapshotViewer feature={feature} /> : <div className="media-empty">THIS CAMERA'S LIVE VIDEO IS PUBLISHED THROUGH THE OFFICIAL VIEWER.</div>}
        <a className="stream-link" href={feature.streamPageUrl} target="_blank" rel="noreferrer">OPEN OFFICIAL LIVE STREAM ↗</a>
      </section>
    );
  }

  if (feature.snapshotUrl) return <SnapshotViewer feature={feature} />;

  return (
    <div className="media-empty">
      {feature.mediaType === 'external' ? 'PUBLIC CAMERA PAGE AVAILABLE · NO EMBEDDABLE MEDIA' : 'NO PUBLIC MEDIA FOR THIS MAPPED CAMERA'}
    </div>
  );
}

import { useCallback, useState } from 'react';
import type { RavenFeature } from '../types';
import { isHlsUrl, LiveVideo, type LiveVideoStatus } from './LiveVideo';
import { SnapshotViewer } from './SnapshotViewer';

const STREAM_STATUS: Record<LiveVideoStatus, { className: string; label: string }> = {
  connecting: { className: 'media-loading', label: 'CONNECTING' },
  live: { className: 'media-active', label: 'LIVE' },
  error: { className: 'media-offline', label: 'STREAM UNAVAILABLE' }
};

export function CameraViewer({ feature }: { feature: RavenFeature }) {
  const [stream, setStream] = useState<{ status: LiveVideoStatus; detail?: string }>({ status: 'connecting' });
  const onStreamStatus = useCallback((status: LiveVideoStatus, detail?: string) => setStream({ status, detail }), []);

  if (feature.streamUrl) {
    const failed = stream.status === 'error';
    const status = STREAM_STATUS[stream.status];
    return (
      <section className="stream-viewer">
        <div className={`media-status ${status.className}`}>
          <span>● {status.label}</span>
          <span>{isHlsUrl(feature.streamUrl) ? 'PUBLIC HLS STREAM' : 'PUBLIC DIRECT MEDIA'}</span>
          {failed && stream.detail && <span>{stream.detail}</span>}
        </div>
        {failed ? (
          <>
            {feature.snapshotUrl ? <SnapshotViewer feature={feature} /> : <div className="media-empty">LIVE STREAM COULD NOT BE PLAYED</div>}
            <button className="stream-link" onClick={() => setStream({ status: 'connecting' })}>RETRY LIVE STREAM</button>
          </>
        ) : (
          <LiveVideo
            src={feature.streamUrl}
            poster={feature.snapshotUrl}
            label={`Live public stream for ${feature.name || feature.sourceId || 'camera'}`}
            onStatus={onStreamStatus}
          />
        )}
        <div className="media-note">Live video published by {feature.operator || feature.providerId}. Playback depends on browser codec support.</div>
        {!failed && feature.snapshotUrl && <details className="media-fallback"><summary>SHOW SNAPSHOT FALLBACK</summary><SnapshotViewer feature={feature} /></details>}
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

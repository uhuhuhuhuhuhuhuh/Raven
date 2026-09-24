import { useCallback, useState } from 'react';
import type { RavenFeature } from '../types';
import { isHlsUrl } from '../providers/normalize';
import { LiveVideo, type LiveVideoStatus } from './LiveVideo';
import { SnapshotViewer } from './SnapshotViewer';

const STREAM_STATUS: Record<LiveVideoStatus, { className: string; label: string }> = {
  connecting: { className: 'media-loading', label: 'Connecting' },
  live: { className: 'media-active', label: 'Live' },
  error: { className: 'media-offline', label: 'Stream unavailable' }
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
          <span className="media-state"><i className="status-dot" aria-hidden="true" />{status.label}</span>
          <span className="chip">{isHlsUrl(feature.streamUrl) ? 'Public HLS stream' : 'Public direct media'}</span>
          {failed && stream.detail && <span className="media-detail">{stream.detail}</span>}
        </div>
        {failed ? (
          <>
            {feature.snapshotUrl ? <SnapshotViewer feature={feature} /> : <div className="media-empty">The live stream could not be played</div>}
            <button className="stream-link" onClick={() => setStream({ status: 'connecting' })}>Retry live stream</button>
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
        {!failed && feature.snapshotUrl && <details className="media-fallback"><summary>Show snapshot fallback</summary><SnapshotViewer feature={feature} /></details>}
      </section>
    );
  }

  if (feature.streamPageUrl) {
    return (
      <section className="stream-viewer external-stream">
        <div className="media-status media-active"><span className="media-state"><i className="status-dot" aria-hidden="true" />Live stream available</span><span className="chip">Official viewer</span></div>
        {feature.snapshotUrl ? <SnapshotViewer feature={feature} /> : <div className="media-empty">This camera's live video is published through the official viewer.</div>}
        <a className="stream-link" href={feature.streamPageUrl} target="_blank" rel="noreferrer">Open official live stream ↗</a>
      </section>
    );
  }

  if (feature.snapshotUrl) return <SnapshotViewer feature={feature} />;

  return (
    <div className="media-empty">
      {feature.mediaType === 'external' ? 'Public camera page available · no embeddable media' : 'No public media for this mapped camera'}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import type { RavenFeature } from '../types';

const REFRESH_OPTIONS = [0, 1000, 3000, 5000, 10000, 30000];

function bust(url: string): string {
  const joiner = url.includes('?') ? '&' : '?';
  return `${url}${joiner}raven_frame=${Date.now()}`;
}

function sourceAge(sourceUpdatedAt?: string): number | null {
  if (!sourceUpdatedAt) return null;
  const parsed = Date.parse(sourceUpdatedAt);
  return Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : null;
}

function formatAge(ms: number | null): string {
  if (ms === null) return 'UNKNOWN';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function SnapshotViewer({ feature }: { feature: RavenFeature }) {
  const [refreshMs, setRefreshMs] = useState(5000);
  const [currentSrc, setCurrentSrc] = useState(feature.snapshotUrl || '');
  const [frameLoadedAt, setFrameLoadedAt] = useState<number | null>(null);
  const [failures, setFailures] = useState(0);
  const [status, setStatus] = useState<'loading' | 'active' | 'stale' | 'offline'>('loading');
  const generation = useRef(0);

  const age = useMemo(() => sourceAge(feature.sourceUpdatedAt), [feature.sourceUpdatedAt, frameLoadedAt]);

  useEffect(() => {
    generation.current += 1;
    const thisGeneration = generation.current;
    let timer: number | undefined;
    let stopped = false;

    const refresh = () => {
      if (!feature.snapshotUrl || stopped) return;
      const image = new Image();
      const next = bust(feature.snapshotUrl);
      image.onload = () => {
        if (stopped || generation.current !== thisGeneration) return;
        setCurrentSrc(next);
        setFrameLoadedAt(Date.now());
        setFailures(0);
        const nextAge = sourceAge(feature.sourceUpdatedAt);
        setStatus(nextAge !== null && nextAge > 120_000 ? 'stale' : 'active');
      };
      image.onerror = () => {
        if (stopped || generation.current !== thisGeneration) return;
        setFailures(previous => {
          const nextFailures = previous + 1;
          setStatus(nextFailures >= 3 ? 'offline' : 'stale');
          return nextFailures;
        });
      };
      image.src = next;
    };

    refresh();
    if (refreshMs > 0) timer = window.setInterval(refresh, refreshMs);
    return () => {
      stopped = true;
      if (timer) window.clearInterval(timer);
    };
  }, [feature.snapshotUrl, feature.sourceUpdatedAt, refreshMs]);

  if (!feature.snapshotUrl) {
    return <div className="media-empty">NO PUBLIC SNAPSHOT URL</div>;
  }

  return (
    <section className="snapshot-viewer">
      <div className={`media-status media-${status}`}>
        <span>● {status.toUpperCase()}</span>
        <span>SOURCE AGE {formatAge(age)}</span>
        <span>FAILURES {failures}</span>
      </div>
      {currentSrc ? (
        <img src={currentSrc} alt={`Public traffic camera snapshot for ${feature.name || feature.sourceId || 'camera'}`} />
      ) : (
        <div className="media-empty">LOADING PUBLIC SNAPSHOT…</div>
      )}
      <div className="snapshot-controls">
        <label>
          <span>AUTO REFRESH</span>
          <select value={refreshMs} onChange={event => setRefreshMs(Number(event.target.value))}>
            {REFRESH_OPTIONS.map(value => (
              <option key={value} value={value}>{value === 0 ? 'OFF' : `${value / 1000}s`}</option>
            ))}
          </select>
        </label>
        <span>FRAME {frameLoadedAt ? new Date(frameLoadedAt).toISOString().slice(11, 19) : '—'} UTC</span>
      </div>
    </section>
  );
}

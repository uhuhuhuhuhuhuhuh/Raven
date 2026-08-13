import { useEffect, useMemo, useRef, useState } from 'react';
import type { RavenFeature } from '../types';

export type EnrichedFeature = RavenFeature & { distance: number; azimuth: number };

const ROW_HEIGHT = 62;
const OVERSCAN = 8;

function formatRange(meters: number) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
}

function typeLabel(feature: RavenFeature) {
  if (feature.mediaType === 'snapshot') return 'SNAP';
  if (feature.mediaType === 'stream') return 'STREAM';
  if (feature.cameraType === 'speed') return 'SPEED';
  return (feature.cameraType || 'unknown').toUpperCase();
}

export function VirtualContactList({
  features,
  selectedId,
  onSelect
}: {
  features: EnrichedFeature[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(480);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const resize = () => setHeight(element.clientHeight || 480);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const range = useMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const visibleCount = Math.ceil(height / ROW_HEIGHT) + OVERSCAN * 2;
    return { start, end: Math.min(features.length, start + visibleCount) };
  }, [scrollTop, height, features.length]);

  return (
    <div ref={viewportRef} className="contact-list" onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
      {features.length === 0 ? (
        <div className="empty-state">NO VISIBLE CONTACTS. SCAN THE CURRENT VIEWPORT OR ENABLE A CAMERA LAYER.</div>
      ) : (
        <div className="virtual-spacer" style={{ height: features.length * ROW_HEIGHT }}>
          {features.slice(range.start, range.end).map((feature, localIndex) => {
            const index = range.start + localIndex;
            return (
              <button
                key={feature.id}
                className={`contact-row virtual-row ${selectedId === feature.id ? 'active' : ''}`}
                style={{ transform: `translateY(${index * ROW_HEIGHT}px)` }}
                onClick={() => onSelect(feature.id)}
              >
                <span className="contact-index">{String(index + 1).padStart(4, '0')}</span>
                <span className="contact-main">
                  <strong>{feature.name || 'CAMERA'}</strong>
                  <small>RNG {formatRange(feature.distance)} · AZ {Math.round(feature.azimuth)}°</small>
                </span>
                <span className={`contact-tag media-${feature.mediaType}`}>{typeLabel(feature)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

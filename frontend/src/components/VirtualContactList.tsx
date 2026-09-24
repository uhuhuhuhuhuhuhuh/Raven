import { useEffect, useMemo, useRef, useState } from 'react';
import { formatRange } from '../geo';
import { MARKER_BY_KEY, markerKey, markerTag } from '../markers';
import type { RavenFeature } from '../types';
import { MarkerSwatch } from './MarkerSwatch';

export type EnrichedFeature = RavenFeature & { distance: number; azimuth: number };

const ROW_HEIGHT = 58;
const OVERSCAN = 8;

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
        <div className="empty-state">
          <strong>No cameras in view</strong>
          <span>Scan the current map view, or turn on a camera layer.</span>
        </div>
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
                <span className="contact-swatch"><MarkerSwatch marker={MARKER_BY_KEY[markerKey(feature)]} size={16} /></span>
                <span className="contact-main">
                  <strong>{feature.name || 'Camera'}</strong>
                  <small>{formatRange(feature.distance)} · {Math.round(feature.azimuth)}°</small>
                </span>
                <span className="chip">{markerTag(feature)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

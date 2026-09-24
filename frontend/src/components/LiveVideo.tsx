import { useEffect, useRef, useState } from 'react';

export type LiveVideoStatus = 'connecting' | 'live' | 'error';

export function isHlsUrl(url: string): boolean {
  return /\.m3u8(?:[?#].*)?$/i.test(url);
}

/**
 * Plays a stream URL a provider publishes in its open data. HLS playlists use the
 * browser's native player where one exists (Safari, iOS, Android) and otherwise
 * load hls.js on demand, so the main bundle does not carry it.
 */
export function LiveVideo({
  src,
  poster,
  label,
  onStatus
}: {
  src: string;
  poster?: string;
  label: string;
  onStatus: (status: LiveVideoStatus, detail?: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const onStatusRef = useRef(onStatus);
  const [nativeHls] = useState(() => typeof document !== 'undefined' && document.createElement('video').canPlayType('application/vnd.apple.mpegurl') !== '');

  useEffect(() => { onStatusRef.current = onStatus; }, [onStatus]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    let destroyHls: (() => void) | undefined;
    const report = (status: LiveVideoStatus, detail?: string) => {
      if (!cancelled) onStatusRef.current(status, detail);
    };
    const onPlaying = () => report('live');
    const onError = () => report('error', 'BROWSER COULD NOT PLAY THIS STREAM');
    video.addEventListener('playing', onPlaying);
    video.addEventListener('error', onError);
    report('connecting');

    if (!isHlsUrl(src) || nativeHls) {
      video.src = src;
    } else {
      import('hls.js/light').then(({ default: Hls }) => {
        if (cancelled) return;
        if (!Hls.isSupported()) {
          report('error', 'HLS PLAYBACK IS NOT SUPPORTED IN THIS BROWSER');
          return;
        }
        const hls = new Hls({ backBufferLength: 30 });
        destroyHls = () => hls.destroy();
        let recoveredMedia = false;
        let retriedNetwork = false;
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          // One recovery attempt per failure class, then give up and fall back to the snapshot.
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recoveredMedia) {
            recoveredMedia = true;
            hls.recoverMediaError();
          } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !retriedNetwork && data.details !== Hls.ErrorDetails.MANIFEST_LOAD_ERROR) {
            retriedNetwork = true;
            hls.startLoad();
          } else {
            report('error', data.details.toUpperCase());
            hls.destroy();
            destroyHls = undefined;
          }
        });
        hls.loadSource(src);
        hls.attachMedia(video);
      }).catch(() => report('error', 'COULD NOT LOAD THE STREAM PLAYER'));
    }

    return () => {
      cancelled = true;
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('error', onError);
      destroyHls?.();
      video.removeAttribute('src');
      video.load();
    };
  }, [src, nativeHls]);

  return <video ref={videoRef} poster={poster} aria-label={label} controls autoPlay muted playsInline />;
}

import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';

interface MoviePlayerProps {
  /** The MediaStream from the remote peer (viewer). */
  stream?: MediaStream | null;
  /** If provided, this src is used directly (streamer playing local file). */
  src?: string;
  /** Whether this user IS the streamer (has local controls). */
  isController: boolean;
  /** Whether the other peer currently has a movie track enabled. */
  streamActive?: boolean;
  controlsEnabled?: boolean;
  onPlay?: (time: number) => boolean | void;
  onPause?: (time: number) => boolean | void;
  onSeeked?: (time: number) => void;
  playbackTime?: number;
  duration?: number;
  onRemoteSeek?: (time: number) => void;
  onTimeUpdate?: (time: number) => void;
  /** Ref exposed so parent can imperatively apply state commands. */
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  /**
   * Called once when the streamer's local video element is ready
   * (src assigned + loadedmetadata fired). Parent uses this to start
   * captureStream() at the right time, before the first play().
   */
  onVideoReady?: (el: HTMLVideoElement) => void;
  onVideoError?: () => void;
  onVideoEnded?: () => void;
}

export default function MoviePlayer({
  stream,
  src,
  isController,
  streamActive = true,
  controlsEnabled = true,
  onPlay,
  onPause,
  onSeeked,
  playbackTime = 0,
  duration = 0,
  onRemoteSeek,
  onTimeUpdate,
  videoRef: externalRef,
  onVideoReady,
  onVideoError,
  onVideoEnded,
}: MoviePlayerProps) {
  const internalRef = useRef<HTMLVideoElement>(null);
  const videoEl = (externalRef ?? internalRef) as React.RefObject<HTMLVideoElement>;

  const [soundLocked, setSoundLocked] = useState(false);
  const [viewerPlaying, setViewerPlaying] = useState(false);
  const [viewerMuted, setViewerMuted] = useState(false);
  // Track if the viewer's stream ended so we can re-request play
  const [streamEnded, setStreamEnded] = useState(false);
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const onVideoReadyRef = useRef(onVideoReady);
  const onVideoErrorRef = useRef(onVideoError);
  const onVideoEndedRef = useRef(onVideoEnded);
  useEffect(() => {
    onVideoReadyRef.current = onVideoReady;
  }, [onVideoReady]);
  useEffect(() => {
    onVideoErrorRef.current = onVideoError;
  }, [onVideoError]);
  useEffect(() => {
    onVideoEndedRef.current = onVideoEnded;
  }, [onVideoEnded]);

  useEffect(() => {
    const doc = document as Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
    const container = containerRef.current as (HTMLDivElement & { webkitRequestFullscreen?: () => Promise<void> | void }) | null;
    setFullscreenSupported(Boolean(document.fullscreenEnabled || container?.webkitRequestFullscreen));
    const updateFullscreen = () => {
      setIsFullscreen(document.fullscreenElement === container || doc.webkitFullscreenElement === container);
    };
    document.addEventListener('fullscreenchange', updateFullscreen);
    document.addEventListener('webkitfullscreenchange', updateFullscreen);
    return () => {
      document.removeEventListener('fullscreenchange', updateFullscreen);
      document.removeEventListener('webkitfullscreenchange', updateFullscreen);
    };
  }, []);

  // Attach stream or src to the video element
  useEffect(() => {
    const el = videoEl.current;
    if (!el) return;
    if (stream) {
      el.removeAttribute('src');
      // The media element is an external playback surface; srcObject must be assigned imperatively.
      // oxlint-disable-next-line react/immutability
      el.srcObject = stream;
      el.muted = false;
      el.play().catch(() => {
        // Autoplay blocked — mute and retry, show overlay
        setSoundLocked(true);
        el.muted = true;
        void el.play();
      });
    } else if (src) {
      el.srcObject = null;
      // Notify parent once metadata is ready so it can captureStream() before play()
      el.onloadedmetadata = () => {
        onVideoReadyRef.current?.(el);
        el.onloadedmetadata = null; // fire only once
      };
      el.onerror = () => onVideoErrorRef.current?.();
      el.src = src;
      el.load();
    }

    return () => {
      el.onloadedmetadata = null;
      el.onerror = null;
      el.pause();
      if (stream) el.srcObject = null;
      if (src) {
        el.removeAttribute('src');
        el.load();
      }
    };
  }, [stream, src, videoEl]);

  useEffect(() => {
    if (!isController && stream && videoEl.current) {
      // oxlint-disable-next-line react/immutability
      videoEl.current.muted = viewerMuted;
    }
  }, [viewerMuted, isController, stream, videoEl]);

  // A muted receiver track becomes live again when the streamer replaces it.
  // The MediaStream identity stays the same, so listen for unmute explicitly.
  useEffect(() => {
    const el = videoEl.current;
    if (!el || !stream || isController) return;
    const onUnmute = () => {
      setStreamEnded(false);
      void el.play().then(() => setSoundLocked(false)).catch(() => setSoundLocked(true));
    };
    const tracks = stream.getVideoTracks();
    tracks.forEach((track) => track.addEventListener('unmute', onUnmute));
    return () => tracks.forEach((track) => track.removeEventListener('unmute', onUnmute));
  }, [stream, isController, videoEl]);

  useEffect(() => {
    const el = videoEl.current;
    if (!el || isController || !streamActive || !stream) return;
    void el.play().catch(() => setSoundLocked(true));
  }, [streamActive, stream, isController, videoEl]);

  // Track local playing state for viewer UI
  useEffect(() => {
    const el = videoEl.current;
    if (!el || isController) return;
    const onP = () => { setViewerPlaying(true); setStreamEnded(false); };
    const onPa = () => setViewerPlaying(false);
    const onEnd = () => { setViewerPlaying(false); setStreamEnded(true); };
    el.addEventListener('play', onP);
    el.addEventListener('pause', onPa);
    el.addEventListener('ended', onEnd);
    return () => {
      el.removeEventListener('play', onP);
      el.removeEventListener('pause', onPa);
      el.removeEventListener('ended', onEnd);
    };
  }, [videoEl, isController]);

  function handlePlay() {
    if (isController) onPlay?.(videoEl.current?.currentTime ?? 0);
  }
  function handlePause() {
    if (isController) onPause?.(videoEl.current?.currentTime ?? 0);
  }
  function handleSeeked() {
    if (isController) onSeeked?.(videoEl.current?.currentTime ?? 0);
  }

  async function unlockSound() {
    const el = videoEl.current;
    if (!el) return;
    // This click is the user's gesture to unlock browser audio playback.
    // oxlint-disable-next-line react/immutability
    el.muted = false;
    try { await el.play(); setSoundLocked(false); } catch { /* still blocked */ }
  }

  function handleViewerPlayPause() {
    const el = videoEl.current;
    if (!el || !controlsEnabled) return;
    if (el.paused || el.ended) {
      if (onPlay?.(el.currentTime) === false) return;
      // Reflect the click immediately while the host's command travels over the data channel.
      void el.play().catch(() => setSoundLocked(true));
      setViewerPlaying(true);
    } else {
      if (onPause?.(el.currentTime) === false) return;
      // Pause the receiver locally; waiting for the host round trip feels laggy.
      el.pause();
      setViewerPlaying(false);
    }
  }

  function handleViewerMuteToggle() {
    const el = videoEl.current;
    if (!el) return;
    const muted = !el.muted;
    // oxlint-disable-next-line react/immutability
    el.muted = muted;
    setViewerMuted(muted);
  }

  function commitRemoteSeek() {
    if (seekPreview !== null && controlsEnabled) onRemoteSeek?.(Math.min(Math.max(0, seekPreview), duration));
    setSeekPreview(null);
  }

  async function toggleFullscreen() {
    const doc = document as Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
    const container = containerRef.current as (HTMLDivElement & { webkitRequestFullscreen?: () => Promise<void> | void }) | null;
    if (!container) return;
    try {
      if (document.fullscreenElement === container || doc.webkitFullscreenElement === container) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else await doc.webkitExitFullscreen?.();
      } else if (container.requestFullscreen) {
        await container.requestFullscreen();
      } else {
        await container.webkitRequestFullscreen?.();
      }
    } catch (error) {
      console.warn('[player] fullscreen request failed', error);
    }
  }

  return (
    <div ref={containerRef} className="movie-player relative w-full overflow-hidden rounded-xl bg-black shadow-2xl">
      <video
        ref={videoEl}
        className="w-full max-h-[70vh]"
        controls={isController}
        playsInline
        onPlay={handlePlay}
        onPause={handlePause}
        onSeeked={handleSeeked}
        onTimeUpdate={(event) => { if (isController) onTimeUpdate?.(event.currentTarget.currentTime); }}
        onEnded={() => { if (isController) onVideoEndedRef.current?.(); }}
      />

      {fullscreenSupported && (
        <button
          type="button"
          onClick={() => { void toggleFullscreen(); }}
          className="absolute right-3 top-3 z-20 rounded-lg bg-black/60 px-3 py-2 text-sm font-medium text-white shadow hover:bg-black/80 focus:outline-none focus:ring-2 focus:ring-blue-400"
          aria-label={isFullscreen ? 'Exit full screen' : 'View movie full screen'}
          title={isFullscreen ? 'Exit full screen' : 'View movie full screen'}
        >
          <Icon name={isFullscreen ? 'fullscreen-exit' : 'fullscreen'} size={17} />
        </button>
      )}

      {/* Viewer controls — send commands to streamer */}
      {!isController && !soundLocked && (
        <div className="absolute bottom-0 left-0 right-0 flex flex-wrap items-center justify-center gap-3 bg-gradient-to-t from-black/90 to-transparent p-4 pt-12">
          <button
            onClick={handleViewerPlayPause}
            disabled={!controlsEnabled}
            title={controlsEnabled ? 'Send playback command to host' : 'Connecting playback controls…'}
            className="rounded-full bg-white/20 px-4 py-2 text-sm font-semibold hover:bg-white/30 disabled:cursor-wait disabled:opacity-50"
          >
            <Icon name={viewerPlaying ? 'pause' : 'play'} size={17} />
          </button>
          <button onClick={() => onRemoteSeek?.(Math.max(0, playbackTime - 10))} disabled={!controlsEnabled || !duration} className="rounded-full bg-white/20 px-3 py-2 text-sm hover:bg-white/30 disabled:opacity-50" aria-label="Back 10 seconds">−10s</button>
          <input type="range" min={0} max={duration || 1} step={1} value={Math.min(seekPreview ?? playbackTime, duration || 0)} disabled={!controlsEnabled || !duration} onChange={(event) => setSeekPreview(Number(event.target.value))} onPointerUp={commitRemoteSeek} onKeyUp={commitRemoteSeek} onBlur={commitRemoteSeek} aria-label="Seek shared movie" className="min-w-28 flex-1 accent-blue-400 disabled:opacity-50" />
          <span className="min-w-20 text-xs text-gray-300 tabular-nums">{formatTime(seekPreview ?? playbackTime)} / {formatTime(duration)}</span>
          <button onClick={() => onRemoteSeek?.(Math.min(duration || playbackTime + 10, playbackTime + 10))} disabled={!controlsEnabled || !duration} className="rounded-full bg-white/20 px-3 py-2 text-sm hover:bg-white/30 disabled:opacity-50" aria-label="Forward 10 seconds">+10s</button>
          <button
            onClick={handleViewerMuteToggle}
            className="rounded-full bg-white/20 px-3 py-2 text-sm font-semibold hover:bg-white/30"
            aria-label={viewerMuted ? 'Unmute movie audio' : 'Mute movie audio'}
          >
            <Icon name={viewerMuted ? 'volume' : 'volume-off'} size={17} />
          </button>
          <span className="text-xs text-gray-400">{controlsEnabled ? 'Controls sent to host' : 'Connecting controls…'}</span>
        </div>
      )}

      {/* Stream stalled / ended indicator for viewer */}
      {!isController && (streamEnded || !streamActive) && !soundLocked && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 text-white gap-3">
          <span className="text-4xl">⏹</span>
          <p className="text-sm text-gray-300">
            {streamActive ? 'Stream ended — click Play to request replay' : 'The other person stopped sharing'}
          </p>
          <button
            onClick={handleViewerPlayPause}
            disabled={!controlsEnabled}
            className="rounded-full bg-white/20 px-6 py-2 text-sm font-semibold hover:bg-white/30 disabled:opacity-50"
          >
            ▶ Play
          </button>
        </div>
      )}

      {/* Sound unlock overlay */}
      {soundLocked && (
        <div
          className="absolute inset-0 z-10 flex cursor-pointer flex-col items-center justify-center bg-black/70 text-white"
          onClick={() => { void unlockSound(); }}
        >
          <span className="text-4xl mb-2">🔇</span>
          <p className="text-lg font-semibold">Click to enable sound</p>
          <p className="text-sm text-gray-400">Your browser requires a click to play audio</p>
        </div>
      )}

      {/* Streamer keep-tab-visible warning */}
      {isController && src && (
        <div className="absolute left-2 top-2 rounded bg-yellow-900/80 px-2 py-1 text-xs text-yellow-200">
          ⚠️ Keep this tab visible — minimizing may cause stream issues
        </div>
      )}
    </div>
  );
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

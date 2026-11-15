import { useEffect, useRef, useState } from 'react';

interface MoviePlayerProps {
  /** The MediaStream from the remote peer (viewer). */
  stream?: MediaStream | null;
  /** If provided, this src is used directly (streamer playing local file). */
  src?: string;
  /** Whether this user IS the streamer (has local controls). */
  isController: boolean;
  onPlay?: (time: number) => void;
  onPause?: (time: number) => void;
  onSeeked?: (time: number) => void;
  /** Ref exposed so parent can imperatively apply state commands. */
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  /**
   * Called once when the streamer's local video element is ready
   * (src assigned + loadedmetadata fired). Parent uses this to start
   * captureStream() at the right time, before the first play().
   */
  onVideoReady?: (el: HTMLVideoElement) => void;
}

export default function MoviePlayer({
  stream,
  src,
  isController,
  onPlay,
  onPause,
  onSeeked,
  videoRef: externalRef,
  onVideoReady,
}: MoviePlayerProps) {
  const internalRef = useRef<HTMLVideoElement>(null);
  const videoEl = (externalRef ?? internalRef) as React.RefObject<HTMLVideoElement>;

  const [soundLocked, setSoundLocked] = useState(false);
  const [viewerPlaying, setViewerPlaying] = useState(false);

  // Attach stream or src to the video element
  useEffect(() => {
    const el = videoEl.current;
    if (!el) return;
    if (stream) {
      el.srcObject = stream;
      el.muted = false;
      el.play().catch(() => {
        // Autoplay blocked — mute and retry, show overlay
        setSoundLocked(true);
        el.muted = true;
        void el.play();
      });
    } else if (src) {
      el.src = src;
      el.load();
      // Notify parent once metadata is ready so it can captureStream() before play()
      el.onloadedmetadata = () => {
        onVideoReady?.(el);
        el.onloadedmetadata = null; // fire only once
      };
    }
  }, [stream, src, videoEl, onVideoReady]);

  // Track local playing state for viewer UI
  useEffect(() => {
    const el = videoEl.current;
    if (!el || isController) return;
    const onP = () => setViewerPlaying(true);
    const onPa = () => setViewerPlaying(false);
    el.addEventListener('play', onP);
    el.addEventListener('pause', onPa);
    return () => { el.removeEventListener('play', onP); el.removeEventListener('pause', onPa); };
  }, [videoEl, isController]);

  function handlePlay() {
    onPlay?.(videoEl.current?.currentTime ?? 0);
  }
  function handlePause() {
    onPause?.(videoEl.current?.currentTime ?? 0);
  }
  function handleSeeked() {
    onSeeked?.(videoEl.current?.currentTime ?? 0);
  }

  async function unlockSound() {
    const el = videoEl.current;
    if (!el) return;
    el.muted = false;
    try { await el.play(); setSoundLocked(false); } catch { /* still blocked */ }
  }

  return (
    <div className="relative w-full overflow-hidden rounded-xl bg-black shadow-2xl">
      <video
        ref={videoEl}
        className="w-full max-h-[70vh]"
        controls={isController}
        playsInline
        onPlay={handlePlay}
        onPause={handlePause}
        onSeeked={handleSeeked}
      />

      {/* Viewer controls — send commands to streamer */}
      {!isController && !soundLocked && (
        <div className="absolute bottom-0 left-0 right-0 flex items-center justify-center gap-4 bg-gradient-to-t from-black/80 to-transparent p-4 opacity-0 hover:opacity-100 transition-opacity">
          <button
            onClick={() => { const el = videoEl.current; if (el) { if (el.paused) onPlay?.(el.currentTime); else onPause?.(el.currentTime); } }}
            className="rounded-full bg-white/20 px-4 py-2 text-sm font-semibold hover:bg-white/30"
          >
            {viewerPlaying ? '⏸ Pause' : '▶ Play'}
          </button>
          <span className="text-xs text-gray-400">Controls sent to streamer</span>
        </div>
      )}

      {/* Sound unlock overlay */}
      {soundLocked && (
        <div
          className="absolute inset-0 flex cursor-pointer flex-col items-center justify-center bg-black/70 text-white"
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

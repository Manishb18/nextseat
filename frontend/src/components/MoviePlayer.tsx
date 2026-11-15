import { useEffect, useRef, useState } from 'react';

interface MoviePlayerProps {
  /** The MediaStream from the remote peer (viewer) or local file (streamer). */
  stream?: MediaStream | null;
  /** If provided, this src is used directly (streamer playing local file). */
  src?: string;
  /** Whether this user controls playback (streamer). */
  isController: boolean;
  onPlay?: (time: number) => void;
  onPause?: (time: number) => void;
  onSeeked?: (time: number) => void;
  /** Ref exposed so parent can call play/pause/seek imperatively. */
  videoRef?: React.RefObject<HTMLVideoElement | null>;
}

export default function MoviePlayer({
  stream,
  src,
  isController,
  onPlay,
  onPause,
  onSeeked,
  videoRef: externalRef,
}: MoviePlayerProps) {
  const internalRef = useRef<HTMLVideoElement>(null);
  const videoEl = externalRef ?? internalRef;

  const [soundLocked, setSoundLocked] = useState(false);

  // Attach stream or src
  useEffect(() => {
    const el = videoEl.current;
    if (!el) return;
    if (stream) {
      el.srcObject = stream;
      el.muted = false;
      el.play().catch(() => {
        // Autoplay blocked — show unlock overlay
        setSoundLocked(true);
        el.muted = true;
        void el.play();
      });
    } else if (src) {
      el.src = src;
    }
  }, [stream, src, videoEl]);

  // Streamer: emit events so Room.tsx can broadcast state
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
    el.muted = false;
    try {
      await el.play();
      setSoundLocked(false);
    } catch {
      // Still blocked — keep overlay
    }
  }

  return (
    <div className="relative w-full overflow-hidden rounded-xl bg-black shadow-2xl">
      <video
        ref={videoEl as React.RefObject<HTMLVideoElement>}
        className="w-full"
        controls={isController}
        playsInline
        onPlay={handlePlay}
        onPause={handlePause}
        onSeeked={handleSeeked}
      />

      {/* Sound unlock overlay for viewer (autoplay policy) */}
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

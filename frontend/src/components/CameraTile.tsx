import { useEffect, useRef, useState } from 'react';

interface CameraTileProps {
  stream: MediaStream | null;
  label: string;
  muted?: boolean;       // true for local tile (always mute own audio)
  mirrored?: boolean;    // true for local tile
  onHide?: () => void;   // only for remote tile
}

export default function CameraTile({
  stream,
  label,
  muted = false,
  mirrored = false,
  onHide,
}: CameraTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hasVideo, setHasVideo] = useState(false);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = stream;
    setHasVideo(!!stream && stream.getVideoTracks().length > 0);
  }, [stream]);

  if (!stream || !hasVideo) {
    return (
      <div className="relative flex h-32 w-44 items-center justify-center rounded-xl bg-gray-800 shadow-lg">
        <span className="text-3xl">🎭</span>
        <div className="absolute bottom-1 left-2 text-xs font-medium text-gray-300">{label}</div>
      </div>
    );
  }

  return (
    <div className="relative h-32 w-44 overflow-hidden rounded-xl bg-black shadow-lg group">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        className={`h-full w-full object-cover ${mirrored ? '-scale-x-100' : ''}`}
      />
      <div className="absolute bottom-1 left-2 text-xs font-medium text-white drop-shadow">
        {label}
      </div>
      {onHide && (
        <button
          onClick={onHide}
          className="absolute right-1 top-1 hidden rounded bg-black/50 px-1.5 py-0.5 text-xs text-white hover:bg-black/80 group-hover:block"
        >
          Hide
        </button>
      )}
    </div>
  );
}

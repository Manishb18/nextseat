import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';

interface CameraTileProps {
  stream: MediaStream | null;
  label: string;
  muted?: boolean;
  mirrored?: boolean;
  onHide?: () => void;
  videoEnabled?: boolean | null;
}

export default function CameraTile({
  stream,
  label,
  muted = false,
  mirrored = false,
  onHide,
  videoEnabled = null,
}: CameraTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hasVideo, setHasVideo] = useState(false);
  const nameParts = label.replace(/\s*\(you\)$/i, '').trim().split(/\s+/).filter(Boolean);
  const initials = (nameParts.length > 1 ? nameParts.map((part) => part[0]).join('') : nameParts[0]?.slice(0, 2) ?? '?').slice(0, 2).toUpperCase();

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = stream;

    const tracks = stream?.getVideoTracks() ?? [];
    const update = () => {
      const active = tracks.some((track) =>
        track.readyState === 'live' && (videoEnabled === true || (videoEnabled !== false && !track.muted)),
      );
      setHasVideo(active);
      if ((stream?.getTracks() ?? []).some((track) => track.readyState === 'live' && !track.muted)) {
        void el.play().catch(() => undefined);
      }
    };

    tracks.forEach((track) => {
      track.addEventListener('mute', update);
      track.addEventListener('unmute', update);
      track.addEventListener('ended', update);
    });
    const audioTracks = stream?.getAudioTracks() ?? [];
    audioTracks.forEach((track) => {
      track.addEventListener('mute', update);
      track.addEventListener('unmute', update);
      track.addEventListener('ended', update);
    });
    stream?.addEventListener('addtrack', update);
    stream?.addEventListener('removetrack', update);
    update();

    return () => {
      tracks.forEach((track) => {
        track.removeEventListener('mute', update);
        track.removeEventListener('unmute', update);
        track.removeEventListener('ended', update);
      });
      audioTracks.forEach((track) => {
        track.removeEventListener('mute', update);
        track.removeEventListener('unmute', update);
        track.removeEventListener('ended', update);
      });
      stream?.removeEventListener('addtrack', update);
      stream?.removeEventListener('removetrack', update);
    };
  }, [stream, videoEnabled]);

  return (
    <div className={`group relative h-32 w-44 overflow-hidden rounded-xl border border-white/5 shadow-lg ${hasVideo ? 'bg-black' : 'bg-slate-900'}`}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        className={`${hasVideo ? 'h-full w-full' : 'sr-only'} object-cover ${mirrored ? '-scale-x-100' : ''}`}
      />
      {!hasVideo && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-slate-800 via-slate-800 to-indigo-950">
          <span className="flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-white/10 text-sm font-semibold tracking-wide text-slate-100">{initials}</span>
          <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-400"><Icon name="camera-off" size={14} /> Camera off</span>
        </div>
      )}
      <div className={`absolute bottom-1 left-2 text-xs font-medium ${hasVideo ? 'text-white drop-shadow' : 'text-gray-300'}`}>
        {label}
      </div>
      {onHide && (
        <button
          onClick={onHide}
          title="Hide this camera"
          aria-label={`Hide ${label} camera`}
          className="absolute right-1 top-1 flex h-8 w-8 items-center justify-center rounded-lg bg-black/55 text-white opacity-100 transition hover:bg-black/80 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
        >
          <Icon name="eye-off" size={16} />
        </button>
      )}
    </div>
  );
}

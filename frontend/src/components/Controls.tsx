import Icon from './Icon';

interface ControlsProps {
  cameraOn: boolean;
  micOn: boolean;
  onToggleCamera: () => void;
  onToggleMic: () => void;
  canShareMovie: boolean;
  isStreaming: boolean;
  onShareMovie: () => void;
  onStopSharing: () => void;
  quality: '480p' | '720p' | '1080p';
  onQualityChange: (q: '480p' | '720p' | '1080p') => void;
  showQuality: boolean;  // only visible to streamer
}

export default function Controls({
  cameraOn,
  micOn,
  onToggleCamera,
  onToggleMic,
  canShareMovie,
  isStreaming,
  onShareMovie,
  onStopSharing,
  quality,
  onQualityChange,
  showQuality,
}: ControlsProps) {
  return (
    <div className="flex items-center justify-center gap-3 border-t border-gray-800 bg-gray-900 px-6 py-3">
      {/* Camera toggle */}
      <button
        onClick={onToggleCamera}
        title={cameraOn ? 'Turn off camera' : 'Turn on camera'}
        aria-label={cameraOn ? 'Turn off camera' : 'Turn on camera'}
        aria-pressed={cameraOn}
        className={`flex h-10 w-10 items-center justify-center rounded-full text-lg transition ${
          cameraOn ? 'bg-gray-700 hover:bg-gray-600' : 'bg-red-700 hover:bg-red-600'
        }`}
      >
        <Icon name={cameraOn ? 'camera' : 'camera-off'} size={19} />
      </button>

      {/* Mic toggle */}
      <button
        onClick={onToggleMic}
        title={micOn ? 'Mute microphone' : 'Unmute microphone'}
        aria-label={micOn ? 'Mute microphone' : 'Unmute microphone'}
        aria-pressed={micOn}
        className={`flex h-10 w-10 items-center justify-center rounded-full text-lg transition ${
          micOn ? 'bg-gray-700 hover:bg-gray-600' : 'bg-red-700 hover:bg-red-600'
        }`}
      >
        <Icon name={micOn ? 'microphone' : 'microphone-off'} size={19} />
      </button>

      {/* Divider */}
      <div className="h-6 w-px bg-gray-700" />

      {/* Movie share */}
      {isStreaming ? (
        <button
          onClick={onStopSharing}
          className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600"
        >
          <span className="inline-flex items-center gap-2"><Icon name="stop" size={16} /> Stop sharing</span>
        </button>
      ) : (
        <button
          onClick={onShareMovie}
          disabled={!canShareMovie}
          title={canShareMovie ? 'Share a movie file' : 'Use Chrome or Edge on desktop to share movies'}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="inline-flex items-center gap-2"><Icon name="film" size={16} /> Share a movie</span>
        </button>
      )}

      {/* Quality selector — only visible to streamer */}
      {showQuality && isStreaming && (
        <select
          value={quality}
          onChange={(e) => onQualityChange(e.target.value as '480p' | '720p' | '1080p')}
          className="rounded bg-gray-800 px-2 py-1 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="480p">480p</option>
          <option value="720p">720p</option>
          <option value="1080p">1080p</option>
        </select>
      )}
    </div>
  );
}

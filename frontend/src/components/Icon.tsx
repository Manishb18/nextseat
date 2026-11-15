export type IconName =
  | 'camera' | 'camera-off' | 'microphone' | 'microphone-off' | 'film'
  | 'stop' | 'door' | 'trash' | 'users' | 'eye' | 'eye-off' | 'chat'
  | 'close' | 'copy' | 'refresh' | 'play' | 'pause' | 'volume' | 'volume-off'
  | 'fullscreen' | 'fullscreen-exit' | 'user' | 'send';

const paths: Record<IconName, string[]> = {
  camera: ['M14 8l5-3a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1l-5-3', 'M3 6h11v12H3z'],
  'camera-off': ['M3 6h8', 'M14 8l5-3a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1l-5-3', 'M3 6v12h11V9', 'M3 3l18 18'],
  microphone: ['M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z', 'M19 10v1a7 7 0 0 1-14 0v-1', 'M12 18v4', 'M8 22h8'],
  'microphone-off': ['M9 9v2a3 3 0 0 0 5.1 2.1', 'M15 9V5a3 3 0 0 0-5.8-1', 'M19 10v1a7 7 0 0 1-1 3.6', 'M5 10v1a7 7 0 0 0 12 5', 'M12 18v4', 'M8 22h8', 'M3 3l18 18'],
  film: ['M4 4h16v16H4z', 'M4 8h16', 'M4 16h16', 'M8 4v4', 'M16 4v4', 'M8 16v4', 'M16 16v4'],
  stop: ['M6 6h12v12H6z'],
  door: ['M10 17l5-5-5-5', 'M15 12H3', 'M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6', 'M10 11v5', 'M14 11v5'],
  users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M22 21v-2a4 4 0 0 0-3-3.9', 'M16 3.1a4 4 0 0 1 0 7.8'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
  'eye-off': ['M3 3l18 18', 'M10.6 10.6a2 2 0 0 0 2.8 2.8', 'M9.9 5.2A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a16 16 0 0 1-3 3.8', 'M6.2 6.2C3.5 8 2 12 2 12s3.5 7 10 7a10.7 10.7 0 0 0 4-.8'],
  chat: ['M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z'],
  close: ['M18 6 6 18', 'M6 6l12 12'],
  copy: ['M8 8h12v13H8z', 'M16 8V3H4v13h4'],
  refresh: ['M20 7v5h-5', 'M4 17v-5h5', 'M5.5 9a7 7 0 0 1 11.6-2L20 12', 'M4 12l2.9 5a7 7 0 0 0 11.6-2'],
  play: ['M7 4l13 8-13 8z'],
  pause: ['M7 5h3v14H7z', 'M14 5h3v14h-3z'],
  volume: ['M11 5 6 9H3v6h3l5 4z', 'M15 9a5 5 0 0 1 0 6', 'M18 6a9 9 0 0 1 0 12'],
  'volume-off': ['M11 5 6 9H3v6h3l5 4z', 'M16 9l5 6', 'M21 9l-5 6'],
  fullscreen: ['M8 3H5a2 2 0 0 0-2 2v3', 'M16 3h3a2 2 0 0 1 2 2v3', 'M21 16v3a2 2 0 0 1-2 2h-3', 'M3 16v3a2 2 0 0 0 2 2h3'],
  'fullscreen-exit': ['M8 3v5H3', 'M21 8h-5V3', 'M16 21v-5h5', 'M3 16h5v5'],
  user: ['M20 21a8 8 0 0 0-16 0', 'M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z'],
  send: ['M22 2 11 13', 'M22 2 15 22l-4-9-9-4z'],
};

export default function Icon({ name, size = 18, className = '' }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {paths[name].map((path) => <path key={path} d={path} />)}
    </svg>
  );
}

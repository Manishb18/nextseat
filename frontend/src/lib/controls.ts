/**
 * Data channel message types and dispatch helpers.
 *
 * All communication that bypasses the signaling server goes through the
 * single RTCDataChannel named "control".
 */

/** Viewer → Streamer: request a playback action. */
export interface CmdMessage {
  t: 'cmd';
  action: 'play' | 'pause' | 'seek';
  time: number;
}

/** Streamer → Viewer: authoritative playback state broadcast. */
export interface StateMessage {
  t: 'state';
  playing: boolean;
  time: number;
  duration: number;
}

/** Either → Either: text chat message. */
export interface ChatMessage {
  t: 'chat';
  text: string;
  name: string;
}

/** Either → Either: track toggle notification (camera on/off). */
export interface TrackToggleMessage {
  t: 'track-toggle';
  kind: 'video' | 'audio';
  enabled: boolean;
}

export type ControlMessage = CmdMessage | StateMessage | ChatMessage | TrackToggleMessage;

export type ControlMessageListener = (msg: ControlMessage) => void;

/** Apply a viewer's request to the streamer's seekable local file. */
export function applyStreamerCommand(video: HTMLVideoElement, msg: CmdMessage): void {
  if (msg.action === 'play') {
    void video.play();
  } else if (msg.action === 'pause') {
    video.pause();
  } else if (Number.isFinite(msg.time) && msg.time >= 0) {
    video.currentTime = Math.min(msg.time, Number.isFinite(video.duration) ? video.duration : msg.time);
  }
}

/** Mirror play/pause on the live receiver; its clock is unrelated to the source file. */
export function applyViewerState(video: HTMLVideoElement, msg: StateMessage): void {
  if (msg.playing && video.paused) void video.play();
  else if (!msg.playing && !video.paused) video.pause();
}

/** Preserve the last known video state for unrelated audio toggle messages. */
export function trackToggleEnabled(current: boolean | null, msg: TrackToggleMessage): boolean | null {
  return msg.kind === 'video' ? msg.enabled : current;
}

/** Send a typed message over the data channel and report whether it was queued. */
export function sendControl(channel: RTCDataChannel | null, msg: ControlMessage): boolean {
  if (!channel || channel.readyState !== 'open') return false;
  try {
    channel.send(JSON.stringify(msg));
    return true;
  } catch {
    // The data channel may close after readyState is checked.
    return false;
  }
}

/**
 * Attach a message listener to the data channel.
 * Returns an unsubscribe function.
 */
export function onControl(
  channel: RTCDataChannel,
  listener: ControlMessageListener,
): () => void {
  const handler = (event: MessageEvent) => {
    try {
      const value: unknown = JSON.parse(event.data);
      if (!value || typeof value !== 'object') return;
      const msg = value as Record<string, unknown>;
      if (msg.t === 'cmd' && (msg.action === 'play' || msg.action === 'pause' || msg.action === 'seek') && typeof msg.time === 'number' && Number.isFinite(msg.time) && msg.time >= 0) {
        listener(msg as unknown as CmdMessage);
      } else if (msg.t === 'state' && typeof msg.playing === 'boolean' && typeof msg.time === 'number' && Number.isFinite(msg.time) && msg.time >= 0 && typeof msg.duration === 'number' && Number.isFinite(msg.duration) && msg.duration >= 0) {
        listener(msg as unknown as StateMessage);
      } else if (msg.t === 'chat' && typeof msg.text === 'string' && msg.text.length <= 500 && typeof msg.name === 'string' && msg.name.length <= 30) {
        listener(msg as unknown as ChatMessage);
      } else if (msg.t === 'track-toggle' && (msg.kind === 'video' || msg.kind === 'audio') && typeof msg.enabled === 'boolean') {
        listener(msg as unknown as TrackToggleMessage);
      }
    } catch {
      // Ignore malformed messages
    }
  };
  channel.addEventListener('message', handler);
  return () => channel.removeEventListener('message', handler);
}

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

/** Send a typed message over the data channel (no-op if channel not open). */
export function sendControl(channel: RTCDataChannel | null, msg: ControlMessage): void {
  if (!channel || channel.readyState !== 'open') return;
  channel.send(JSON.stringify(msg));
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
      const msg = JSON.parse(event.data) as ControlMessage;
      listener(msg);
    } catch {
      // Ignore malformed messages
    }
  };
  channel.addEventListener('message', handler);
  return () => channel.removeEventListener('message', handler);
}

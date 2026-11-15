/**
 * WebSocket signaling wrapper.
 *
 * Connects to /ws/{code}, sends the initial join message,
 * and emits typed events for all server messages.
 */

export type SignalingEvent =
  | { type: "joined"; peerId: string; polite: boolean; peers: Array<{ peerId: string; name: string }> }
  | { type: "peer-joined"; name: string; peerId: string }
  | { type: "peer-left"; peerId: string }
  | { type: "room-full" }
  | { type: "signal"; data: Record<string, unknown> }
  | { type: "error"; message: string };

type Listener = (event: SignalingEvent) => void;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private listeners: Listener[] = [];

  /** Connect to the signaling server for a room code. */
  connect(code: string, name: string): void {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws/${code}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.ws?.send(JSON.stringify({ type: "join", name }));
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as SignalingEvent;
        this.listeners.forEach((fn) => fn(msg));
      } catch {
        // Ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      // Could emit a disconnect event if needed
    };
  }

  /** Send a signaling message (SDP offer/answer or ICE candidate). */
  sendSignal(data: Record<string, unknown>): void {
    this.ws?.send(JSON.stringify({ type: "signal", data }));
  }

  /** Register an event listener. */
  on(fn: Listener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  /** Send a leave message and close the connection. */
  disconnect(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "leave" }));
    }
    this.ws?.close();
    this.ws = null;
  }
}

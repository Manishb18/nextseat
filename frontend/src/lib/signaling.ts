/**
 * WebSocket signaling wrapper.
 *
 * Connects to /ws/{code}, sends the initial join message,
 * and emits typed events for all server messages.
 */

export type SignalingEvent =
  | { type: "joined"; peerId: string; polite: boolean; isCreator: boolean; peers: Array<{ peerId: string; name: string }> }
  | { type: "peer-joined"; name: string; peerId: string }
  | { type: "peer-left"; peerId: string }
  | { type: "peer-reconnected"; name: string; peerId: string }
  | { type: "reconnecting" }
  | { type: "room-full" }
  | { type: "room-deleted" }
  | { type: "delete-denied" }
  | { type: "invite-invalid" }
  | { type: "kicked" }
  | { type: "invite-rotated"; inviteToken: string }
  | { type: "signal"; fromPeerId: string; data: Record<string, unknown> }
  | { type: "error"; message: string };

type Listener = (event: SignalingEvent) => void;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private listeners: Listener[] = [];
  private code = '';
  private name = '';
  private ownerToken = '';
  private inviteToken = '';
  private clientId = crypto.randomUUID();
  private retryTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private retryAttempt = 0;
  private stopped = true;

  /** Connect to the signaling server for a room code. */
  connect(code: string, name: string, ownerToken = '', inviteToken = ''): void {
    this.code = code;
    this.name = name;
    this.ownerToken = ownerToken;
    this.inviteToken = inviteToken;
    this.stopped = false;
    this.retryAttempt = 0;
    if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try { this.ws.send(JSON.stringify({ type: 'ping' })); } catch { /* Socket is closing. */ }
      }
    }, 5 * 60 * 1000);
    this.openSocket();
  }

  private openSocket(): void {
    if (this.stopped) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws/${this.code}`;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      if (this.ws !== socket || this.stopped) return;
      socket.send(JSON.stringify({ type: "join", name: this.name, clientId: this.clientId, ownerToken: this.ownerToken, inviteToken: this.inviteToken }));
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as SignalingEvent;
        if ((msg as { type?: string }).type === 'pong') return;
        if (msg.type === 'joined') this.retryAttempt = 0;
        if (msg.type === 'room-deleted') this.stopped = true;
        if (msg.type === 'room-full' || msg.type === 'error') this.stopped = true;
        if (msg.type === 'invite-invalid' || msg.type === 'kicked') this.stopped = true;
        this.listeners.forEach((fn) => fn(msg));
      } catch {
        // Ignore malformed messages
      }
    };

    socket.onclose = () => {
      if (this.ws !== socket || this.stopped) return;
      this.ws = null;
      this.listeners.forEach((fn) => fn({ type: 'reconnecting' }));
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer !== null) return;
    const delay = Math.min(500 * 2 ** this.retryAttempt, 8_000);
    this.retryAttempt += 1;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.openSocket();
    }, delay);
  }

  /** Force a fresh signaling session; useful when the media path is stuck. */
  reconnect(): void {
    if (this.stopped) return;
    this.listeners.forEach((fn) => fn({ type: 'reconnecting' }));
    const socket = this.ws;
    this.ws = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryAttempt = 0;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.openSocket();
    }, 0);
  }

  /** Send a signaling message (SDP offer/answer or ICE candidate). */
  sendSignal(data: Record<string, unknown>, targetPeerId?: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({ type: "signal", ...(targetPeerId ? { targetPeerId } : {}), data }));
    } catch {
      // A socket can close between the readyState check and send().
    }
  }

  /** Ask the server to end the room; the server verifies the creator token. */
  deleteRoom(): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify({ type: 'delete-room' }));
      return true;
    } catch {
      return false;
    }
  }

  /** Ask the server to remove a participant; only the host may kick. */
  kickPeer(targetPeerId: string): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify({ type: 'kick', targetPeerId }));
      return true;
    } catch {
      return false;
    }
  }

  /** Ask the server to rotate the invite token; only the host may do this. */
  rotateInvite(): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify({ type: 'rotate-invite' }));
      return true;
    } catch {
      return false;
    }
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
    this.stopped = true;
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: "leave" })); } catch { /* socket is closing */ }
    }
    this.ws?.close();
    this.ws = null;
  }
}

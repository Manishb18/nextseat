/**
 * PeerManager — RTCPeerConnection with the Perfect Negotiation pattern.
 *
 * The "perfect negotiation" pattern (see MDN docs) prevents offer collisions
 * when both sides try to renegotiate simultaneously. The key insight:
 * - The "impolite" peer (first joiner) ignores incoming offers when it's
 *   already creating its own offer.
 * - The "polite" peer (second joiner) rolls back its own offer and accepts
 *   the incoming one instead.
 *
 * This is essential for mid-call renegotiation (adding movie tracks).
 */

import type { SignalingClient } from './signaling';

export interface PeerManagerOptions {
  polite: boolean;
  signaling: SignalingClient;
  onTrack?: (event: RTCTrackEvent) => void;
  onDataChannel?: (channel: RTCDataChannel) => void;
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  onIceConnectionStateChange?: (state: RTCIceConnectionState) => void;
}

export interface IceConfig {
  iceServers: RTCIceServer[];
  iceTransportPolicy?: RTCIceTransportPolicy;
}

export class PeerManager {
  readonly pc: RTCPeerConnection;
  private polite: boolean;
  private signaling: SignalingClient;
  private makingOffer = false;
  private ignoreOffer = false;

  /** The control data channel (created by impolite peer; received by polite peer). */
  controlChannel: RTCDataChannel | null = null;

  constructor(iceConfig: IceConfig, opts: PeerManagerOptions) {
    this.polite = opts.polite;
    this.signaling = opts.signaling;

    this.pc = new RTCPeerConnection({
      iceServers: iceConfig.iceServers,
      iceTransportPolicy: iceConfig.iceTransportPolicy ?? 'all',
    });

    // ── Perfect negotiation ──────────────────────────────────────────

    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription(); // implicitly creates an offer
        this.signaling.sendSignal({ description: this.pc.localDescription });
      } catch (err) {
        console.error('[peer] negotiationneeded error', err);
      } finally {
        this.makingOffer = false;
      }
    };

    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.signaling.sendSignal({ candidate });
      }
    };

    // ── Tracks ──────────────────────────────────────────────────────

    if (opts.onTrack) {
      this.pc.ontrack = opts.onTrack;
    }

    // ── Data channel ────────────────────────────────────────────────

    if (!this.polite) {
      // Impolite (first joiner) creates the channel
      this.controlChannel = this.pc.createDataChannel('control', {
        ordered: true,
      });
    }

    this.pc.ondatachannel = (event) => {
      if (event.channel.label === 'control') {
        this.controlChannel = event.channel;
      }
      opts.onDataChannel?.(event.channel);
    };

    // ── Connection state ────────────────────────────────────────────

    if (opts.onConnectionStateChange) {
      this.pc.onconnectionstatechange = () => {
        opts.onConnectionStateChange?.(this.pc.connectionState);
      };
    }

    if (opts.onIceConnectionStateChange) {
      this.pc.oniceconnectionstatechange = () => {
        opts.onIceConnectionStateChange?.(this.pc.iceConnectionState);
      };
    }
  }

  /**
   * Handle an incoming signaling message (SDP description or ICE candidate).
   * This is the core of the perfect negotiation pattern.
   */
  async handleSignal(data: Record<string, unknown>): Promise<void> {
    try {
      if (data['description']) {
        const description = data['description'] as RTCSessionDescriptionInit;

        // Collision: we're making an offer and received one simultaneously.
        const offerCollision =
          description.type === 'offer' &&
          (this.makingOffer || this.pc.signalingState !== 'stable');

        this.ignoreOffer = !this.polite && offerCollision;
        if (this.ignoreOffer) return; // Impolite ignores the collision

        // Polite peer: roll back own offer and accept remote offer
        await this.pc.setRemoteDescription(description);

        if (description.type === 'offer') {
          await this.pc.setLocalDescription(); // implicitly creates answer
          this.signaling.sendSignal({ description: this.pc.localDescription });
        }
      } else if (data['candidate']) {
        const candidate = data['candidate'] as RTCIceCandidateInit;
        try {
          await this.pc.addIceCandidate(candidate);
        } catch (err) {
          // Ignore candidates that arrive while ignoring an offer (normal in perfect negotiation)
          if (!this.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.error('[peer] handleSignal error', err);
    }
  }

  /** Add a local media track to the peer connection. */
  addTrack(track: MediaStreamTrack, stream: MediaStream): RTCRtpSender {
    return this.pc.addTrack(track, stream);
  }

  /** Remove a track from the peer connection. */
  removeTrack(sender: RTCRtpSender): void {
    try {
      this.pc.removeTrack(sender);
    } catch {
      // Ignore if already removed
    }
  }

  /** Replace the track on a sender (e.g. toggle camera). */
  async replaceTrack(sender: RTCRtpSender, track: MediaStreamTrack | null): Promise<void> {
    await sender.replaceTrack(track);
  }

  /**
   * Initiate an ICE restart after a network drop.
   * The onnegotiationneeded handler will fire and create a new offer with iceRestart=true.
   */
  restartIce(): void {
    this.pc.restartIce();
  }

  /** Close and clean up the peer connection. */
  close(): void {
    this.pc.close();
  }

  /** Get current stats for the connection badge. */
  async getStats(): Promise<RTCStatsReport> {
    return this.pc.getStats();
  }
}

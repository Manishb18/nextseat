import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PeerManager } from '../src/lib/peer.ts';

test('buffers ICE candidates until a remote description is installed', async () => {
  const addedCandidates: RTCIceCandidateInit[] = [];
  let remoteDescriptionSet = false;

  class FakePeerConnection {
    signalingState = 'stable';
    remoteDescription: RTCSessionDescriptionInit | null = null;
    onnegotiationneeded: (() => void) | null = null;
    onicecandidate: (() => void) | null = null;
    ontrack: (() => void) | null = null;
    ondatachannel: (() => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    oniceconnectionstatechange: (() => void) | null = null;
    connectionState = 'new';
    iceConnectionState = 'new';

    createDataChannel() { return { readyState: 'connecting' }; }
    async addIceCandidate(candidate: RTCIceCandidateInit) {
      assert.equal(remoteDescriptionSet, true);
      addedCandidates.push(candidate);
    }
    async setRemoteDescription(description: RTCSessionDescriptionInit) {
      remoteDescriptionSet = true;
      this.remoteDescription = description;
    }
    async setLocalDescription() {}
  }

  const original = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = FakePeerConnection as unknown as typeof RTCPeerConnection;
  try {
    const manager = new PeerManager({ iceServers: [] }, {
      polite: true,
      signaling: { sendSignal() {} } as never,
    });
    const candidate = { candidate: 'candidate:1 1 UDP 1 127.0.0.1 9 typ host' };

    await manager.handleSignal({ candidate });
    assert.deepEqual(addedCandidates, []);

    await manager.handleSignal({ description: { type: 'offer', sdp: 'v=0' } });
    assert.deepEqual(addedCandidates, [candidate]);
  } finally {
    globalThis.RTCPeerConnection = original;
  }
});

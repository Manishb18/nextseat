import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SignalingClient } from '../src/lib/signaling.ts';

test('does not throw when sending a signal while the socket is still connecting', () => {
  class ConnectingSocket {
    static instance: ConnectingSocket;
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(_url: string) { ConnectingSocket.instance = this; }
    send() { throw new Error('WebSocket is not open'); }
    close() {}
  }

  const originalWebSocket = globalThis.WebSocket;
  const originalWindow = globalThis.window;
  globalThis.WebSocket = ConnectingSocket as unknown as typeof WebSocket;
  globalThis.window = { location: { protocol: 'http:', host: 'localhost' } } as Window & typeof globalThis;
  try {
    const client = new SignalingClient();
    client.connect('ABC234', 'Test');
    assert.doesNotThrow(() => client.sendSignal({ candidate: { candidate: 'x' } }));
  } finally {
    ConnectingSocket.instance?.close();
    globalThis.WebSocket = originalWebSocket;
    globalThis.window = originalWindow;
  }
});

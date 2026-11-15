import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyStreamerCommand, applyViewerState, sendControl, trackToggleEnabled } from '../src/lib/controls.ts';

test('pause requests do not seek the streamer to the viewer live-stream clock', () => {
  const calls: string[] = [];
  const video = {
    currentTime: 125.5,
    play: () => { calls.push('play'); return Promise.resolve(); },
    pause: () => { calls.push('pause'); },
  } as unknown as HTMLVideoElement;

  applyStreamerCommand(video, { t: 'cmd', action: 'pause', time: 3.2 });

  assert.equal(video.currentTime, 125.5);
  assert.deepEqual(calls, ['pause']);
});

test('seek requests use the time requested by the viewer', () => {
  const video = {
    currentTime: 125.5,
    play: () => Promise.resolve(),
    pause() {},
  } as unknown as HTMLVideoElement;

  applyStreamerCommand(video, { t: 'cmd', action: 'seek', time: 42 });

  assert.equal(video.currentTime, 42);
});

test('streamer state never seeks the live receiver to the source-file clock', () => {
  const calls: string[] = [];
  const video = {
    currentTime: 3.2,
    paused: false,
    play: () => { calls.push('play'); return Promise.resolve(); },
    pause: () => { calls.push('pause'); },
  } as unknown as HTMLVideoElement;

  applyViewerState(video, { t: 'state', playing: false, time: 125.5 });

  assert.equal(video.currentTime, 3.2);
  assert.deepEqual(calls, ['pause']);
});

test('remote camera enabled state follows each explicit sender toggle', () => {
  assert.equal(trackToggleEnabled(null, { t: 'track-toggle', kind: 'video', enabled: true }), true);
  assert.equal(trackToggleEnabled(true, { t: 'track-toggle', kind: 'video', enabled: false }), false);
  assert.equal(trackToggleEnabled(false, { t: 'track-toggle', kind: 'audio', enabled: true }), false);
});

test('viewer controls report when the data channel is unavailable', () => {
  let payload = '';
  const channel = { readyState: 'open', send: (value: string) => { payload = value; } } as unknown as RTCDataChannel;
  const closed = { readyState: 'connecting', send() {} } as unknown as RTCDataChannel;

  assert.equal(sendControl(closed, { t: 'cmd', action: 'pause', time: 0 }), false);
  assert.equal(sendControl(channel, { t: 'cmd', action: 'pause', time: 0 }), true);
  assert.deepEqual(JSON.parse(payload), { t: 'cmd', action: 'pause', time: 0 });
});

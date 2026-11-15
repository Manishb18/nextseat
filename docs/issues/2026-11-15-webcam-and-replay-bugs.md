# Bug Report: Webcam Not Showing + Movie Replay Not Syncing

**Date:** 2026-11-15  
**Reported by:** User  
**Status:** 🔴 Active — fix in progress  
**Branch:** `main`

---

## Bug 1 — Webcam stream not visible on the remote peer

### Symptom
Peer A turns on the camera (📷 button). Peer A sees their own local tile. Peer B sees nothing — no camera tile appears.

### Root Cause
In `Room.tsx`, the `ontrack` handler routes all incoming streams through a single `remoteStream` state. There is a race-condition "fix" `useEffect` that watches `movieStreamId + remoteStream` and moves movie streams to `viewerMovieStream`. The side-effect of this fix:

```ts
// When movieStreamId changes and remoteStream matches, move it:
setViewerMovieStream(remoteStream);
setRemoteStream(null);   // ← WIPES camera stream too!
```

Any camera `MediaStream` that happened to arrive around the same time as a movie `stream-meta` signal gets nulled out. Even without the race, there's only one `remoteStream` slot — camera and movie share it, so whichever arrives second overwrites the first.

**Additionally**, the camera toggle used `addTrack` / `removeTrack` on every toggle. `removeTrack` triggers renegotiation (a new offer/answer), and `replaceTrack(null)` is the correct low-overhead alternative. Without renegotiation the remote `ontrack` does not reliably re-fire.

### Affected files
- `frontend/src/pages/Room.tsx` — `ontrack` handler, camera toggle handlers

---

## Bug 2 — Movie replay on shared device does not update on viewer

### Symptom
Streamer (Peer A) shares a movie. Viewer (Peer B) sees it fine. Streamer clicks "Stop", then shares again (same or different file). Viewer is stuck on "Receiving stream…" or still shows the old ended video.

### Root Cause
On **stop**, `handleStopSharing` did:
```ts
for (const sender of movieSendersRef.current) pm?.removeTrack(sender);
movieSendersRef.current = [];
```

On **restart**, `startMovieStream` calls `captureVideoStream()` → new `MediaStream` with a **new `.id`**. Then `addTrack(track, newStream)` is called.

The WebRTC spec says `ontrack` fires on the remote peer **only for new transceivers** (first `addTrack`). When the same peer connection reuses an existing transceiver slot (which the browser does after `removeTrack + addTrack`), the remote `ontrack` **may not fire again**. The viewer's `setViewerMovieStream` callback is therefore never called for the replay, so the state stays stale.

**Fix approach**: Keep the senders alive across stop/start cycles. On stop, `replaceTrack(null)` to mute. On restart, `replaceTrack(newTrack)` to resume — no renegotiation, no new transceiver, `ontrack` fires reliably for the replaced track.

### Affected files
- `frontend/src/pages/Room.tsx` — `startMovieStream`, `handleStopSharing`, sender refs

---

## TypeScript Error Found During Fix Attempt

```
src/pages/Room.tsx(414,24): error TS18047: 'pm' is possibly 'null'.
```

In `handleStopSharing`, `pm` is obtained from `peerRef.current` before async calls, but TypeScript doesn't know the ref still holds the same value at the `replaceTrack` call sites inside the function. Fix: null-check each usage or use optional chaining.

---

## Fix Plan

1. **Split remote stream state** — introduce `remoteCamStream` (separate from `viewerMovieStream`). The `ontrack` handler routes by stream ID.
2. **Camera/mic toggle** — use `replaceTrack()` instead of `removeTrack()` + `addTrack()`. Keep senders alive in `camSenderRef` / `micSenderRef`.
3. **Movie senders** — keep video sender in `movieVideoSenderRef`, audio in `movieAudioSenderRef`. Stop = `replaceTrack(null)`. Restart = `replaceTrack(newTrack)`.
4. **Remove the race-fix useEffect** — no longer needed once camera and movie streams are routed to separate state.
5. **Fix TS18047** — guard `pm` at call sites inside `handleStopSharing`.

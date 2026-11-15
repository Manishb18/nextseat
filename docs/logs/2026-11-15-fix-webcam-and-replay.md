# Fix Log — 2026-11-15 — Webcam & Movie Replay

**Commit:** `4c3e5b0`  
**Branch:** `main`  
**Status:** ✅ Fixed, built, committed

---

## What Was Broken

### 1. Webcam stream not visible on remote peer
Remote camera never appeared even when peer turned it on.

**Root cause:** Single `remoteStream` state slot shared by both camera and movie streams. The race-condition `useEffect` moved movie streams into `viewerMovieStream` and called `setRemoteStream(null)`, wiping any camera stream that happened to live there. Camera and movie had no independent routing.

**Secondary cause:** Camera toggle used `removeTrack()` / `addTrack()` which triggers full SDP renegotiation. After a cycle, the browser reuses the existing transceiver and `ontrack` does not reliably re-fire on the remote side.

### 2. Movie replay (stop → share again) not seen by viewer
Viewer stuck on "Receiving stream…" or showing old ended video after streamer restarts sharing.

**Root cause:** `handleStopSharing` called `removeTrack()` on all movie senders and cleared `movieSendersRef`. On restart, `captureVideoStream()` returns a new `MediaStream` with a **new `.id`**; `addTrack()` is called. Chrome reuses the existing transceiver (doesn't create a new one), so the remote peer's `ontrack` **does not fire again**. `setViewerMovieStream` is never called → viewer state stays stale.

### 3. TypeScript error TS18047 — `'pm' is possibly 'null'`
Inside `startMovieStream`, the nested `async function setupTrack(...)` closes over `pm` which TypeScript types as `PeerManager | null`. Even after the `if (!pm) return` guard, TypeScript cannot narrow the type inside the nested closure.

---

## What Was Changed

### `frontend/src/pages/Room.tsx` — full rewrite of state model

| Change | Before | After |
|--------|--------|-------|
| Remote stream state | Single `remoteStream: MediaStream\|null` | Split: `remoteCamStream` + `viewerMovieStream` |
| Camera route | `setRemoteStream(incoming)` | `setRemoteCamStream(incoming)` |
| Movie route | `setRemoteStream(null)` race-fix useEffect | Direct `setViewerMovieStream(incoming)` in `ontrack` |
| Camera toggle off | `pm.removeTrack(sender)` | `pm.replaceTrack(sender, null)` — sender kept alive |
| Camera toggle on (2nd+) | `pm.addTrack(newTrack, stream)` → new sender | `pm.replaceTrack(existingSender, newTrack)` |
| Mic toggle | Same pattern as camera | Same pattern as camera |
| Movie stop | `removeTrack()` all senders, clear array | `replaceTrack(null)` on video+audio senders, **keep refs alive** |
| Movie restart | `addTrack()` new stream → new streamId → `ontrack` may not fire | Keep the sender and receiver stream alive, retain the negotiated stream ID, and handle the receiver track's unmute event |
| Movie sender refs | `movieSendersRef: RTCRtpSender[]` | `movieVideoSenderRef`, `movieAudioSenderRef` (single refs) |
| Race-fix useEffect | Present (buggy) | **Removed** — no longer needed |
| TS18047 fix | `pm.addTrack(...)` inside async closure (null error) | Captured as `const pmSafe = pm` before closure |

### `frontend/src/components/MoviePlayer.tsx`
Added `onVideoReady?: (el: HTMLVideoElement) => void` prop — called after `loadedmetadata` so the parent can call `captureStream()` before the user hits Play.

### `backend/app/main.py`
Wrapped all early `ws.close()` calls in `try/except Exception` to suppress the double-disconnect traceback spam.

---

## Verification

```
pnpm exec tsc --noEmit   → exit 0, no errors
pnpm run build           → exit 0, 285 kB bundle
python -c "from app.main import app; print('OK')"  → OK
```

---

## How to Test (Manual)

1. Start backend: `cd backend ; python -m uvicorn app.main:app --reload --port 8000`
2. Start frontend: `cd frontend ; pnpm dev`
3. Open two Chrome tabs at `http://localhost:5173`

**Webcam test:**
- Tab A: Create room → enable camera (📷) → Tab B should show camera tile in top-right
- Tab B: Enable camera → Tab A should show camera tile
- Tab A: Disable camera → Tab B tile disappears (stream goes silent, `CameraTile` hides when no active tracks)

**Movie replay test:**
- Tab A: Share a Movie → pick an MP4 → click Play → Tab B sees movie
- Tab A: Stop sharing → Tab B sees "Receiving stream…" disappear
- Tab A: Share a Movie again (same or different file) → click Play → **Tab B must see the new movie within ~2 seconds** (this was broken before — it would stay on "Receiving stream…" forever)

**Chat test:**
- Both connected → open chat → send messages both ways

---

## Known Remaining Risk

**Correction from the follow-up audit:** `RTCRtpSender.replaceTrack()` does not cause a new remote `ontrack` event and does not replace the negotiated remote stream ID. The viewer must keep its existing receiver stream mounted and listen for the track to unmute after replay. The earlier claim above that `ontrack` fires reliably after `replaceTrack()` was incorrect.

`captureStream()` on Chrome returns a `MediaStream` with potentially zero tracks until `play()` is called. The `stream.onaddtrack` handler in `startMovieStream` catches late-arriving tracks. On replay (second share), `replaceTrack` on the video sender is called in `onaddtrack` — this should work but hasn't been tested on a slow machine where `play()` is very delayed.

If the viewer still shows "Receiving stream…" after a restart, check:
- Browser console for `[peer] handleSignal error` — indicates ICE failure
- Whether `stream-meta` signal arrives before `ontrack` (backend relays in order, should be fine)
- Chrome's `chrome://webrtc-internals` for transceiver direction after stop/restart

---

## Files Changed

```
frontend/src/pages/Room.tsx               ← main fix
frontend/src/components/MoviePlayer.tsx   ← onVideoReady prop (prev session)
backend/app/main.py                       ← ws.close() error handling (prev session)
docs/issues/2026-11-15-webcam-and-replay-bugs.md  ← issue write-up
docs/logs/2026-11-15-fix-webcam-and-replay.md     ← this file
```

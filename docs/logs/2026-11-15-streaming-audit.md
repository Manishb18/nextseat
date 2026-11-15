# Streaming and Recovery Audit

## Findings and fixes

- Buffered ICE candidates until a remote description exists; candidates that arrived early were previously dropped.
- Made signaling sends safe during socket transitions and added automatic WebSocket retries with capped backoff. A per-tab client ID lets the server replace a stale socket without taking a second room slot. Both peers rebuild the peer connection and reattach live local media after a signaling reconnect.
- Kept camera and microphone senders reusable, removed stopped local tracks before replacement, and made the camera tile observe remote `mute`, `unmute`, and `ended` events. Audio-only microphone streams now play through the hidden video element.
- Kept movie receiver streams mounted through stop/replay and reused their negotiated stream ID. `replaceTrack()` does not fire another `ontrack` event; the viewer resumes on the existing receiver track's `unmute` event.
- Removed the unstable `onVideoReady` callback from `MoviePlayer`'s source-effect dependencies. Parent rerenders previously reloaded the movie and created repeated capture streams.
- Separated the source-file clock from the viewer's live receiver clock. Pause and state messages no longer seek the streamer's file to the viewer's unrelated `currentTime`; only explicit seek commands change the file position.
- Corrected seek state reporting, connection-path reporting, room cleanup for created-but-never-joined rooms, and malformed signaling-message handling.

## Verification

- `pnpm run build` — passed.
- `pnpm test` — 5 tests passed.
- `pnpm test:integration` — two WebSocket peers joined, one reconnected with its original identity, and signaling relayed after reconnect.
- `GET /api/health` — returned `{"status":"ok"}`.
- A two-tab camera and movie UI check could not be completed because the browser-control host rejected inspection of the current Chrome URL.

## Deployment dependency

The current ICE configuration contains a STUN server but no TURN server. Same-network or localhost calls can connect directly, but users behind restrictive NATs or firewalls may need configured TURN credentials. WebRTC also cannot guarantee zero delay; bitrate and resolution adapt to available upload bandwidth.

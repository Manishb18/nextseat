# Watch Party Implementation Plan

> **For Antigravity:** REQUIRED WORKFLOW: Use `.agent/workflows/execute-plan.md` to execute this plan in single-flow mode.

**Goal:** Build a 2-person browser app where one user streams a local movie file to another via WebRTC, with optional camera/mic and text chat.

**Architecture:** FastAPI backend for signaling (WebSocket) and room management (in-memory). React+Vite+TypeScript+Tailwind frontend. All media travels peer-to-peer via WebRTC. A single RTCDataChannel carries playback commands and chat.

**Tech Stack:** Python 3.11 / FastAPI / Uvicorn · Vite / React 18 / TypeScript (strict) / Tailwind CSS · Native WebRTC APIs · Docker + Caddy

---

## Phase 0: Scaffolding

**Acceptance test:** `GET /api/health` returns `{"status":"ok"}`, frontend loads at `http://localhost:5173`, dev proxy forwards `/api/*` and `/ws/*` to the backend.

### Task 0.1: Backend project setup

**Files:**
- Create: `backend/app/__init__.py`
- Create: `backend/app/main.py`
- Create: `backend/app/config.py`
- Create: `backend/requirements.txt`

**Steps:**
1. Create `backend/requirements.txt` with `fastapi`, `uvicorn[standard]`, `python-dotenv`.
2. Create `backend/app/config.py` — load env vars (ICE servers, FORCE_RELAY, rate limits).
3. Create `backend/app/main.py` — FastAPI app with `GET /api/health` returning `{"status":"ok"}`.
4. Verify: `cd backend && pip install -r requirements.txt && uvicorn app.main:app --port 8000` → `curl localhost:8000/api/health` returns ok.

### Task 0.2: Frontend project setup

**Files:**
- Create: `frontend/` (Vite scaffold)
- Create: `frontend/src/App.tsx`, `frontend/src/main.tsx`
- Create: `frontend/tailwind.config.js`, `frontend/postcss.config.js`

**Steps:**
1. Scaffold Vite React-TS project in `frontend/`.
2. Install and configure Tailwind CSS.
3. Configure Vite proxy: `/api` → `http://localhost:8000`, `/ws` → `ws://localhost:8000`.
4. Create minimal `App.tsx` with a "Watch Party" heading.
5. Verify: `cd frontend && npm run dev` → page loads, clicking `/api/health` via proxy returns ok.

### Task 0.3: .env.example and README stub

**Files:**
- Create: `.env.example`
- Create: `README.md`

**Steps:**
1. Create `.env.example` with all env vars documented (STUN/TURN URLs, credentials, FORCE_RELAY, rate-limit params).
2. Create `README.md` with run instructions for dev mode.

---

## Phase 1: Rooms and Signaling

**Acceptance test:** Two browser tabs see each other's names after joining. A third tab gets "Room is full".

### Task 1.1: Room manager

**Files:**
- Create: `backend/app/rooms.py`

**Steps:**
1. Build `RoomManager` class: in-memory dict of `code → Room(peers, created_at)`.
2. `create_room()` — generates 6-char code (charset: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, no 0/O/1/I), returns code.
3. `join_room(code, ws, name)` — max 2 peers, returns `(peer_id, is_polite)` or raises RoomFull.
4. `leave_room(code, ws)` — removes peer, starts 60s cleanup timer if empty.
5. Rate-limit: track room-creation and join counts per IP with sliding window.

### Task 1.2: REST endpoint for room creation

**Files:**
- Modify: `backend/app/main.py`

**Steps:**
1. Add `POST /api/rooms` — calls `RoomManager.create_room()`, returns `{"code": "..."}`.
2. Add `GET /api/ice-config` — returns ICE servers from env vars, respects `FORCE_RELAY`.
3. Apply per-IP rate limit to both endpoints.

### Task 1.3: WebSocket signaling endpoint

**Files:**
- Modify: `backend/app/main.py`

**Steps:**
1. Add `WS /ws/{code}` — on connect: join room, send `{type:"joined", peerId, polite, peers}` to new peer, send `{type:"peer-joined", name}` to existing peer.
2. On message: if `type == "signal"`, relay `data` to the other peer. If `type == "leave"`, remove peer.
3. On disconnect: remove peer, send `{type:"peer-left"}` to remaining peer, schedule 60s room cleanup.
4. If room full, send `{type:"room-full"}` and close WebSocket.

### Task 1.4: Frontend — Home page and Join flow

**Files:**
- Create: `frontend/src/pages/Home.tsx`
- Create: `frontend/src/pages/Room.tsx` (stub)
- Create: `frontend/src/lib/signaling.ts`
- Modify: `frontend/src/App.tsx` (add routing)

**Steps:**
1. Install `react-router-dom`. Add routes: `/` → Home, `/r/:code` → Room.
2. Home page: name input, "Create Room" button (calls `POST /api/rooms`), "Join Room" code input.
3. `signaling.ts`: WebSocket wrapper class — `connect(code, name)`, event emitters for `joined`, `peer-joined`, `peer-left`, `room-full`, `signal`.
4. Room page (stub): connect WebSocket on mount, display peer names, show "Room is full" message.
5. Serve frontend static files from FastAPI in production (mount after API routes, fallback to `index.html`).

### Task 1.5: Verify Phase 1

1. Open two tabs → both see each other's name.
2. Open third tab → sees "Room is full".
3. Close both tabs → room is cleaned up after 60s.

---

## Phase 2: Camera and Mic (WebRTC Connection)

**Acceptance test:** Two tabs see and hear each other's camera/mic. Toggling camera off removes the tile on the remote side.

### Task 2.1: Perfect negotiation peer connection

**Files:**
- Create: `frontend/src/lib/peer.ts`

**Steps:**
1. Implement `PeerManager` class wrapping a single `RTCPeerConnection`.
2. Fetch ICE config from `/api/ice-config` on init.
3. Implement the **perfect negotiation pattern** (MDN):
   - `onnegotiationneeded` → create offer, set local description, send via signaling.
   - On receiving offer/answer: if collision and polite → rollback + accept; if impolite → ignore incoming offer.
   - `onicecandidate` → send candidate via signaling.
4. Create RTCDataChannel named `"control"` (ordered, reliable) on the impolite side; handle `ondatachannel` on polite side.
5. Track connection state, expose events: `ontrack`, `ondatachannel`, `onconnectionstatechange`.

### Task 2.2: Camera/mic toggle logic

**Files:**
- Create: `frontend/src/lib/media.ts`

**Steps:**
1. `getLocalMedia(video: boolean, audio: boolean)` — calls `getUserMedia` with audio constraints: `echoCancellation: true, noiseSuppression: true, autoGainControl: true`.
2. `toggleCamera()` / `toggleMic()` — add/remove tracks from the peer connection.
3. When removing a track, call `sender.replaceTrack(null)` and notify via data channel `{t:"track-toggle", kind:"video"|"audio", enabled}`.

### Task 2.3: Room page UI — camera tiles and controls

**Files:**
- Modify: `frontend/src/pages/Room.tsx`
- Create: `frontend/src/components/CameraTile.tsx`
- Create: `frontend/src/components/Controls.tsx`

**Steps:**
1. Room page: on join, establish peer connection. Display local camera tile (mirrored) and remote camera tile.
2. Camera/mic toggle buttons (default OFF). "Use headphones 🎧" notice on join screen.
3. `CameraTile.tsx`: video element, "Hide" button that locally hides the remote tile, mute-remote-audio button.
4. Controls bar: camera toggle, mic toggle. Visual indicators for on/off state.

### Task 2.4: Verify Phase 2

1. Two tabs on same machine: enable camera/mic on both → see and hear each other.
2. Toggle camera off on tab A → tile disappears on tab B.
3. Two devices on same network: same test.

---

## Phase 3: Movie Streaming

**Acceptance test:** A 720p H.264 MP4 plays on the viewer within 5 seconds, with sound. An MKV/HEVC file shows the conversion help message.

### Task 3.1: Movie file validation

**Files:**
- Create: `frontend/src/lib/movie.ts`

**Steps:**
1. `validateMovieFile(file: File)` — create hidden `<video>`, set `src` to object URL, wait for `loadedmetadata`.
2. Check: `videoWidth > 0`, has audio track (`videoEl.audioTracks?.length > 0` or fallback heuristic).
3. On failure: return error with help message including the ffmpeg commands from the PRD.
4. Feature-detect `captureStream`: check `HTMLMediaElement.prototype.captureStream || HTMLMediaElement.prototype.mozCaptureStream`. If absent, disable "Share a Movie" with "Use Chrome or Edge on desktop" message.

### Task 3.2: captureStream and track management

**Files:**
- Modify: `frontend/src/lib/movie.ts`
- Modify: `frontend/src/lib/peer.ts`

**Steps:**
1. After validation, play the file in a visible `<video>` (the streamer's player).
2. Call `videoEl.captureStream()` (with `mozCaptureStream` fallback).
3. Listen to `stream.onaddtrack` — as tracks appear, add them to the peer connection via `pc.addTrack(track, stream)`.
4. Before adding the first movie track, send `{type:"stream-meta", streamId: stream.id, kind:"movie"}` over signaling so the viewer knows this stream is the movie.
5. Set `track.contentHint = "motion"` on the video track.

### Task 3.3: Video sender tuning

**Files:**
- Modify: `frontend/src/lib/peer.ts`

**Steps:**
1. After adding the video track, get the `RTCRtpSender`.
2. Use `sender.setParameters()` to set:
   - `maxBitrate`: 480p → 1,200,000, 720p → 3,000,000, 1080p → 6,000,000.
   - `scaleResolutionDownBy`: computed from source height / target height.
   - `degradationPreference: "maintain-framerate"`.
3. Default quality: 720p. Expose a `setQuality(level)` method.

### Task 3.4: Viewer — receiving and displaying the movie

**Files:**
- Create: `frontend/src/components/MoviePlayer.tsx`
- Modify: `frontend/src/pages/Room.tsx`

**Steps:**
1. On `ontrack` event, check `event.streams[0].id` against known movie `streamId` from `stream-meta`.
2. If it's the movie stream, attach to the `MoviePlayer` component's `<video>` element.
3. MoviePlayer: fullscreen button, volume slider. Start with sound enabled (the Join button was the user gesture).
4. "Click to enable sound" overlay fallback: if `video.play()` rejects with NotAllowedError, show overlay; on click, call `video.play()`.
5. Show a "Keep this tab visible" warning to the streamer.

### Task 3.5: Share / Stop sharing UI

**Files:**
- Modify: `frontend/src/pages/Room.tsx`
- Modify: `frontend/src/components/Controls.tsx`

**Steps:**
1. "Share a Movie" button opens file picker (accept `.mp4,.webm,.mov,.mkv`).
2. On file select → validate → if ok, start streaming. Show "Stop Sharing" button.
3. "Stop Sharing" removes movie tracks from the peer connection, sends `{type:"stream-meta", streamId, kind:"movie-ended"}` via signaling.
4. Only one streamer at a time: if peer is already streaming, disable the button.

### Task 3.6: Verify Phase 3

1. Tab A shares a 720p H.264 MP4 → Tab B sees it within 5 seconds, with sound.
2. Tab A selects an incompatible file → sees ffmpeg conversion message.
3. "Stop Sharing" removes the movie from Tab B.

---

## Phase 4: Controls and Polish

**Acceptance test:** Viewer's pause pauses the streamer's player. Quality selector works. Connection badge shows status. Chat works. Wi-Fi disconnect for 5s + reconnect resumes.

### Task 4.1: Playback control via data channel

**Files:**
- Create: `frontend/src/lib/controls.ts`
- Modify: `frontend/src/components/MoviePlayer.tsx`

**Steps:**
1. Data channel message types:
   - Viewer → Streamer: `{t:"cmd", action:"play"|"pause"|"seek", time: number}`
   - Streamer → Viewer: `{t:"state", playing: boolean, time: number}`
2. Streamer: on receiving `cmd`, apply to local `<video>` (play/pause/seek). Broadcast `state` after applying.
3. Streamer: on local play/pause/seek events, broadcast `state`.
4. Viewer: display current state. Viewer controls send `cmd` messages, do NOT directly control local video.
5. Viewer's video element time is slaved to the streamer's state broadcasts.

### Task 4.2: Quality selector

**Files:**
- Modify: `frontend/src/components/Controls.tsx`
- Modify: `frontend/src/lib/peer.ts`

**Steps:**
1. Dropdown: 480p / 720p (default) / 1080p. Only visible to streamer.
2. On change, call `peerManager.setQuality(level)` which updates sender parameters.

### Task 4.3: Connection badge

**Files:**
- Create: `frontend/src/components/ConnectionBadge.tsx`
- Modify: `frontend/src/lib/peer.ts`

**Steps:**
1. Poll `pc.getStats()` every 2 seconds.
2. Determine: connection type (direct/relay from `candidateType`), current send bitrate (delta `bytesSent`), RTT (from `currentRoundTripTime`).
3. Display badge: 🟡 Connecting / 🟢 Direct / 🔵 Relay + bitrate + RTT.

### Task 4.4: ICE restart on disconnect

**Files:**
- Modify: `frontend/src/lib/peer.ts`

**Steps:**
1. On `iceconnectionstate === "disconnected"` or `"failed"`, attempt ICE restart: `pc.restartIce()`.
2. If the streamer disconnects, keep the room for 60s. On reconnect, prompt "Pick your movie file again" and restore playback position from the viewer's last known time.

### Task 4.5: Text chat

**Files:**
- Create: `frontend/src/components/Chat.tsx`
- Modify: `frontend/src/lib/controls.ts`
- Modify: `frontend/src/pages/Room.tsx`

**Steps:**
1. Data channel message: `{t:"chat", text: string, name: string}`.
2. Chat component: input field, message list, auto-scroll. Collapsible panel.
3. Show chat messages with sender name and timestamp.

### Task 4.6: Verify Phase 4

1. Viewer clicks pause → streamer's player pauses.
2. Streamer seeks → viewer jumps to same position.
3. Change quality to 480p → bitrate drops in connection badge.
4. Connection badge shows "Direct" or "Relay" with bitrate and RTT.
5. Disconnect Wi-Fi for 5s → reconnect → stream resumes.
6. Send chat messages both ways.

---

## Phase 5: Deploy and Real-World Test

**Acceptance test:** Two people on different networks watch 10 minutes without a freeze. Forced-relay mode works.

### Task 5.1: Dockerfile

**Files:**
- Create: `Dockerfile`

**Steps:**
1. Multi-stage: Node stage builds frontend, Python stage copies build output + backend.
2. Serve frontend static files from FastAPI.
3. Expose port 8000.

### Task 5.2: docker-compose.yml with Caddy

**Files:**
- Create: `docker-compose.yml`
- Create: `Caddyfile`

**Steps:**
1. Services: `app` (the Dockerfile) and `caddy` (automatic HTTPS reverse proxy).
2. Caddy config: reverse proxy to `app:8000`, handle WebSocket upgrade for `/ws/*`.
3. Environment variables from `.env`.

### Task 5.3: Production static file serving

**Files:**
- Modify: `backend/app/main.py`

**Steps:**
1. If `frontend/dist/` exists, mount it as static files.
2. Catch-all route returns `index.html` for SPA routing (handles `/r/<code>` paths).

### Task 5.4: README finalization

**Files:**
- Modify: `README.md`

**Steps:**
1. Dev setup instructions (backend + frontend).
2. Docker build and run.
3. Environment variables reference.
4. Testing guide: two-tab test, cross-network test, forced-relay test.
5. Deploy steps.

### Task 5.5: Verify Phase 5

1. `docker-compose up` → site loads over HTTPS.
2. Two different networks (e.g., one on phone hotspot): watch 10 minutes, no freeze.
3. Set `FORCE_RELAY=true` → connection badge shows "Relay", video still plays.

---

## File Summary

```
watch-party-app/
├── backend/
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py          # FastAPI app, routes, WS, static serving
│   │   ├── rooms.py         # In-memory room manager
│   │   └── config.py        # Env var loading
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx           # Router
│   │   ├── pages/
│   │   │   ├── Home.tsx      # Create/Join room
│   │   │   └── Room.tsx      # Main room page
│   │   ├── lib/
│   │   │   ├── signaling.ts  # WebSocket wrapper
│   │   │   ├── peer.ts       # RTCPeerConnection + perfect negotiation
│   │   │   ├── movie.ts      # File validation + captureStream
│   │   │   ├── media.ts      # getUserMedia helpers
│   │   │   └── controls.ts   # Data channel message handling
│   │   └── components/
│   │       ├── MoviePlayer.tsx
│   │       ├── CameraTile.tsx
│   │       ├── Controls.tsx
│   │       ├── ConnectionBadge.tsx
│   │       └── Chat.tsx
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   ├── vite.config.ts
│   └── package.json
├── docs/
│   ├── PRD.md
│   └── plans/
│       └── 2026-11-15-watch-party-implementation.md
├── .env.example
├── Dockerfile
├── docker-compose.yml
├── Caddyfile
└── README.md
```

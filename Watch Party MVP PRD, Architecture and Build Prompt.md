# Watch Party MVP: PRD, Architecture and Build Prompt

Version 0.1 · 15 November 2026 · Scope: 2-person rooms · Confidence tags: \[Certain\] hard evidence, \[Likely\] strong inference, \[Guessing\] gap-filling

## 1. Product summary

A browser-based private room for exactly two people. One person picks a movie file from their own computer, and the other person watches it live in their browser, with optional webcams and voice. The movie is never uploaded to any server. It travels directly from one browser to the other.

**Goals**

- Two people join a room by code and watch a local movie together within one minute.
- Playback is shared: when one person pauses, both are paused.
- Camera and mic are optional and can be hidden at any time.

**Non-goals for the MVP**

- Accounts, login, payments, public rooms, more than 2 people, subtitles, mobile streaming, recording, hosting movies on a server.

## 2. Key decisions

**Is a backend required?** Yes, but only a tiny one. Two browsers cannot find each other without a rendezvous point. The backend does signaling only: it introduces the two browsers and passes connection messages between them. Video never touches it. \[Certain\]

A zero-backend option exists (a hosted broker such as PeerJS Cloud), but you would depend on a third party and still need a TURN server. Use it for a throwaway spike at most. \[Likely\]

**Is FastAPI a good choice?** Yes. It has native WebSocket support, is async, and a signaling server is about 150 lines. Node with the `ws` library would be equally good. Use FastAPI since you proposed it. \[Certain\]

**Stack**

- Frontend: Vite, React, TypeScript, Tailwind CSS. Native browser WebRTC APIs, no wrapper library.
- Backend: Python 3.11+, FastAPI, Uvicorn. In-memory room store. No database.
- Video and audio transport: WebRTC peer-to-peer.
- Signaling: WebSocket.
- Controls and chat: WebRTC data channel (no server involved).
- NAT traversal: public STUN plus a TURN relay.
- Deployment: one small VM, FastAPI serving the built frontend and the WebSocket on the same origin, Caddy in front for HTTPS.

**About "no lag".** Zero lag is not achievable. Expect about 0.3 to 1 second between the streamer's screen and the viewer's screen \[Likely\]. What you do get is no buffering: WebRTC lowers picture quality when bandwidth is short instead of stalling. So the failure mode is a blurrier picture, not a frozen one. Set the target as "under 1 second delay, no buffering spinner".

## 3. User flow

1. Person A opens the site, enters a name, clicks Create Room, and gets a 6-character code and a link.
2. Person B opens the link (or enters the code) and enters a name.
3. Both land in the room. Camera and mic are off by default.
4. Either person clicks Share a Movie and picks a local file. That person becomes the streamer.
5. The other person sees the movie player. Camera tiles float over a corner and can be hidden.
6. Either person can request play, pause, or seek. The streamer's player executes it.
7. Stop Sharing ends the movie. Leaving closes the room after a short grace period.

## 4. Functional requirements

**Rooms**

- FR1. Create a room via `POST /api/rooms`. It returns a 6-character code (letters and digits, excluding look-alikes such as 0/O and 1/I).
- FR2. Join via code or link `/r/<code>`, with a display name. Maximum 2 participants. A third visitor sees "Room is full".
- FR3. A room is deleted 60 seconds after it becomes empty.

**Media**

- FR4. Camera and mic are off by default. Toggles are on the join screen and in the room.
- FR5. Each user can hide the remote camera tile and mute remote voice. Both are local-only actions.
- FR6. Either user can start sharing a movie. Only one streamer at a time. A Stop Sharing button ends it.
- FR7. The movie file is validated before streaming (see problem P1).
- FR8. The viewer gets a player with fullscreen and volume.

**Playback control**

- FR9. The streamer has normal play, pause, and seek controls.
- FR10. The viewer has play, pause, and seek controls that send requests to the streamer over the data channel. The streamer's player applies them.

**Quality of life**

- FR11. Streamer picks quality: 480p, 720p (default), 1080p.
- FR12. Connection indicator: connecting, connected direct, connected via relay, current bitrate, round-trip time.
- FR13. Text chat over the data channel (should-have).
- FR14. Automatic recovery from short network drops using ICE restart.

**Non-functional**

- Streamer: desktop Chrome or Edge, latest. Viewer: any modern browser, including mobile.
- HTTPS everywhere (required for camera and mic).
- Nothing persisted: no accounts, no logs of content, no database.

## 5. Architecture

```
 Browser A                                      Browser B
 +---------------+    WebSocket (signaling)    +---------------+
 | <video> file  | <-----> FastAPI <---------> |               |
 | captureStream |        (room map)           |   <video>     |
 +-------+-------+                             +-------+-------+
         |        WebRTC: movie + cam + mic + data     |
         +--------------- direct peer-to-peer ---------+
                  (via TURN relay only if needed)
```

### 5.1 Backend (FastAPI)

- `POST /api/rooms` creates a room and returns its code.
- `GET /api/ice-config` returns STUN and TURN servers from environment variables (so TURN credentials are not hard-coded in the frontend).
- `WS /ws/{code}` is the signaling channel.
- Static files: serve the built frontend, with a fallback to `index.html` for `/r/<code>`.
- Room store: a Python dict, `code -> {peers: [ws, ws], created_at}`. A single process is enough. \[Certain\] (If you later run multiple processes, you need Redis. Not for the MVP.)

**Signaling messages (JSON)**

- Client to server: `{type:"join", name}`, `{type:"signal", data:{...}}`, `{type:"leave"}`.
- Server to client: `{type:"joined", peerId, polite, peers}`, `{type:"peer-joined", name}`, `{type:"peer-left"}`, `{type:"room-full"}`, `{type:"signal", data:{...}}`.
- The server only relays `signal` payloads to the other peer. It never inspects them.
- The second joiner is the "polite" peer, the first is "impolite" (see perfect negotiation below).

### 5.2 Frontend

Suggested structure:

```
frontend/src/
  pages/Home.tsx, Room.tsx
  lib/signaling.ts      // WebSocket wrapper
  lib/peer.ts           // RTCPeerConnection + perfect negotiation
  lib/movie.ts          // file validation + captureStream
  lib/controls.ts       // data channel commands and state
  components/MoviePlayer.tsx, CameraTile.tsx, Controls.tsx, ConnectionBadge.tsx, Chat.tsx
```

### 5.3 WebRTC design

- One `RTCPeerConnection` per room, since there are only two people.
- Use the **perfect negotiation pattern** (documented on MDN). The movie tracks are added after the call starts, so renegotiation must work in both directions without collisions. \[Certain\]
- **Streamer capture:** `const stream = videoEl.captureStream()`, falling back to `mozCaptureStream()`. In Chrome the captured stream can have no tracks until playback starts, so listen to `stream.onaddtrack` and add tracks to the connection as they appear. \[Likely\]
- **Telling streams apart:** before adding movie tracks, send `{type:"stream-meta", streamId, kind:"movie"}` over signaling. On the viewer, `ontrack` uses `event.streams[0].id` to decide whether a track belongs to the movie or to the camera.
- **Video sender tuning:** set `contentHint = "motion"` on the video track. Use `RTCRtpSender.setParameters` to set `maxBitrate` (480p: 1.2 Mbps, 720p: 3 Mbps, 1080p: 6 Mbps) and `scaleResolutionDownBy` computed from the source height. Set `degradationPreference = "maintain-framerate"`.
- **Audio:** movie audio travels as an Opus track. Default WebRTC Opus is low-bitrate and may sound thin. A later improvement is enabling stereo at 128 kbps through the SDP `fmtp` line (`stereo=1;sprop-stereo=1;maxaveragebitrate=128000`). \[Likely\]
- **Microphone constraints:** `echoCancellation`, `noiseSuppression`, and `autoGainControl` all true.
- **Data channel:** one ordered, reliable channel named `control`. Messages: `{t:"cmd", action:"play"|"pause"|"seek", time}`, `{t:"state", playing, time}`, `{t:"chat", text}`.
- **ICE servers:** fetched from `/api/ice-config`. For testing TURN, support an environment flag that sets `iceTransportPolicy: "relay"`.

## 6. Problems you will hit, and the easiest fix for each

**P1. Movie file will not play in the browser.** Many movie files are MKV with HEVC video or AC3/DTS audio, which browsers often cannot decode. \[Certain\] MP4 with H.264 video and AAC audio, and WebM, play reliably. Fix: after the user selects a file, load it into a hidden `<video>` and wait for `loadedmetadata`. If it errors, or `videoWidth` is 0, or there is no audio track, show: "This file isn't browser-compatible. Convert it with this command" and display: `ffmpeg -i input.mkv -c:v libx264 -c:a aac -movflags +faststart output.mp4` If the source video is already H.264, this is much faster: `ffmpeg -i input.mkv -c:v copy -c:a aac output.mp4`. A built-in converter is a post-MVP feature.

**P2. Streamer's upload bandwidth is too low.** 720p needs about 3 Mbps up, 1080p about 6 Mbps. \[Likely\] Home upload speeds are often below that. Fix: default to 720p, cap bitrate, let WebRTC adapt, and show a hint when the streamer's measured send bitrate is below the target (from `getStats`). Tell users to run a speed test if the picture is blurry.

**P3. Direct connection fails because of NAT or firewalls.** Roughly 10 to 20% of pairs cannot connect peer-to-peer. \[Likely\] Fix: always include a TURN server in the ICE config. For the MVP, a managed TURN free tier (for example Metered or Cloudflare) is faster to set up than running coturn. Later, run coturn on your own VM. With 2 people, relayed traffic is about 3 to 4 Mbps, which is manageable. Verify with the forced-relay test flag.

**P4. Camera and mic do not work on the deployed site.** Browsers only allow `getUserMedia` on HTTPS or `localhost`. \[Certain\] Fix: deploy behind Caddy (automatic HTTPS) and use `wss://` for signaling.

**P5. Echo and feedback.** The viewer's mic can pick up the movie from their speakers and send it back to the streamer. Fix: mic off by default, echo cancellation on, and a one-line "Use headphones" notice on the join screen. Later, add push-to-talk.

**P6. Viewer's browser blocks sound (autoplay policy).** Videos with sound cannot autoplay without a user gesture. \[Certain\] Fix: the Join Room button click counts as the gesture. Start the viewer's `<video>` unmuted only after that click, and show a "Click to enable sound" overlay as a fallback.

**P7. Streamer's tab is throttled or minimized.** Backgrounded tabs can be throttled, which may cause stutter in the captured stream. \[Likely\] Fix: tell the streamer to keep the tab visible (a separate window is fine) and not minimize it. Show this in the Share dialog.

**P8. Host closes or refreshes the page.** The stream ends. The browser cannot remember the file path after a refresh. Fix: keep the room alive for 60 seconds after a disconnect. On reconnect, the streamer sees "Pick your movie file again" and the resume position is restored from the viewer's last known time. Host migration is out of scope.

**P9. Browser support for capture.** `captureStream` on media elements works in Chrome and Edge, and Firefox has a prefixed version. Safari is unreliable. \[Likely\] Fix: feature-detect `HTMLMediaElement.prototype.captureStream`. If unsupported, disable Share a Movie and tell the user to use Chrome or Edge on desktop. Viewing works anywhere.

**P10. Streamer's CPU load.** The browser decodes the movie and re-encodes it live. On weak laptops, 1080p may heat up or stutter. \[Likely\] Fix: default to 720p, and offer 480p. Do not add extra video effects.

**P11. Play and pause desync.** Because the viewer watches a live stream, there is nothing to sync. The only risk is conflicting commands. Fix: the streamer's player is the single source of truth. The viewer only sends requests and displays state broadcast by the streamer.

**P12. Room code abuse.** Random 6-character codes are guessable at scale. \[Likely\] Fix for the MVP: cap rooms at 2 people, expire empty rooms, rate-limit room creation and join attempts per IP, and never list rooms publicly.

**P13. Legal exposure.** The site never stores or transmits files through your server, which lowers risk, but it can be used to share pirated content. \[Likely\] Fix: private rooms only, no public directory, a short terms line saying users are responsible for the content they share. Do not market it as a piracy tool.

**P14. Subtitles.** `captureStream` carries no subtitle tracks. Fix: out of MVP. Later: streamer loads an .srt, sends cues over the data channel, and the viewer renders them as an overlay.

## 7. Build phases and acceptance tests

**Phase 0: scaffolding.** FastAPI and Vite projects, dev proxy, health check. Done when: `GET /api/health` returns ok and the frontend loads.

**Phase 1: rooms and signaling.** Create and join by code, max 2, presence. Done when: two browser tabs see each other's names, and a third tab gets "room full".

**Phase 2: camera and mic.** Perfect-negotiation connection, toggles, hide remote tile. Done when: two tabs on one machine, then two devices on one network, see and hear each other; toggling camera off removes the tile on the other side.

**Phase 3: movie streaming.** File picker, validation, `captureStream`, stream to the viewer. Done when: a 720p H.264 MP4 plays on the viewer within 5 seconds of starting, with sound, and an MKV with HEVC shows the conversion help message.

**Phase 4: controls and polish.** Play, pause, seek from both sides, quality selector, connection badge, chat, ICE restart. Done when: viewer's pause pauses the streamer's player; unplugging Wi-Fi for 5 seconds and reconnecting resumes the stream.

**Phase 5: deploy and real-world test.** HTTPS, TURN, Docker Compose. Done when: two people on different networks (for example one on a phone hotspot) watch 10 minutes without a freeze, and the forced-relay test also works.

&#91;Guessing\] Phases 0 to 3 are a weekend or two with an AI agent. Phase 5 is where most surprises appear, so do a cross-network test as early as Phase 3.

## 8. Suggested repository layout

```
watch-party/
  backend/
    app/main.py        # FastAPI app, routes, WebSocket
    app/rooms.py       # in-memory room manager
    app/config.py      # env vars (ICE servers, limits)
    requirements.txt
  frontend/            # Vite + React + TypeScript + Tailwind
  docs/PRD.md
  Dockerfile
  docker-compose.yml   # app + caddy (+ coturn later)
  README.md
```

## 9. Future scope (not in the MVP)

Subtitles, built-in transcoding (ffmpeg.wasm or a small desktop helper), 3 or more people (needs an SFU such as LiveKit), host migration, screen share mode, mobile streamer, accounts and saved rooms.
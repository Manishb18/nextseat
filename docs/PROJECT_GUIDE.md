# Watch Party: Project, Architecture, and Interview Guide

This guide explains the product from first principles, maps the intended design to the current code, and collects the concepts useful for presenting or learning from it. It is based on `README.md`, `docs/PRD.md`, and the implementation under `backend/` and `frontend/src/`.

## 1. The idea in one minute

Watch Party lets two people watch a movie together in a private browser room. One person selects a video file stored on their own computer. Their browser plays and captures that video, then sends the resulting audio/video stream directly to the other person's browser using WebRTC. Both users can coordinate playback, chat, and optionally share camera and microphone.

The central product decision is that the movie is **not uploaded to the application server**. The server helps the browsers find and connect to each other; it does not host, store, or relay the movie in the normal direct-connection case. A TURN server may relay encrypted WebRTC packets when network restrictions prevent a direct peer-to-peer connection.

In plain language: the backend is the introduction and room attendant; the two browsers carry the actual movie conversation.

## 2. Who it is for and what problem it solves

The target use case is two people who have a compatible local video file and want to watch it together remotely without uploading it to a public service or relying on a shared streaming catalog. A room code makes joining simple, and synchronized controls make the experience feel collaborative.

### Product goals

- Two people can create/join a private room quickly using a short code or link.
- Either person can share a locally stored movie.
- Playback requests from either participant affect the shared source playback.
- Camera and microphone are optional and off by default.
- The application works across ordinary home networks where possible, and can fall back to TURN relay.

### MVP non-goals

The PRD excludes accounts, payments, public room discovery, more than two participants, server-hosted movies, recording, built-in transcoding, subtitles, host migration, and mobile movie streaming. These exclusions keep the first version small and keep server bandwidth/storage requirements low.

## 3. User journey

1. The host enters a display name and creates a room.
2. The app generates a six-character room code and a creator token; the host shares the code/link.
3. The second participant enters a name and joins. A third participant is rejected because rooms have a two-person limit.
4. Both browsers establish signaling through the FastAPI server, then negotiate a WebRTC connection.
5. Either person may enable camera/microphone. Either may select a compatible local movie and become its streamer.
6. The streamer browser captures its playing `<video>` element. WebRTC sends its audio/video tracks to the other browser.
7. Playback requests, authoritative playback state, chat, and camera toggle metadata travel over a WebRTC data channel.
8. Leaving/disconnecting updates room presence; empty rooms are eventually cleaned up. The creator can explicitly end the room.

## 4. System architecture

```text
                         HTTPS / WSS
Browser A  <-------------------------------------->  Caddy reverse proxy
   |                                                      |
   | REST: create room, fetch ICE config                 | routes HTTP + WebSocket
   | WebSocket: join, SDP, ICE, presence                 |
   +----------------------------------------------------> FastAPI backend
   |                                                      | in-memory room map
   |                                                      | rate limiting
   |                                                      | static frontend in production
   |                                                      |
   +=========== WebRTC audio/video + data channel =======+========== Browser B
              direct path when ICE can establish it
              TURN relay path when direct path fails
```

### Components and responsibilities

| Component | Responsibility | Main implementation |
|---|---|---|
| React + TypeScript client | Screens, local file selection, local media, WebRTC lifecycle and UI state | `frontend/src/pages/`, `frontend/src/components/` |
| Signaling client | WebSocket connection, reconnect/backoff, messages to/from server | `frontend/src/lib/signaling.ts` |
| Peer manager | `RTCPeerConnection`, SDP/ICE exchange handling, media tracks, data channel | `frontend/src/lib/peer.ts` |
| Movie utilities | Compatibility checks, `captureStream`, bitrate/resolution configuration | `frontend/src/lib/movie.ts` |
| Playback/control helpers | Typed control messages and playback state application | `frontend/src/lib/controls.ts` |
| FastAPI app assembly | Builds the application and includes route modules | `backend/app/main.py` |
| HTTP and WebSocket API | Health, room creation, ICE config, local IP report, and signaling handlers | `backend/app/api/` |
| Backend services | Trusted client IP resolution and SMTP delivery | `backend/app/services/` |
| Static frontend serving | Production asset mount and SPA fallback | `backend/app/static_files.py` |
| Room manager | Room codes, participant slots, creator identity, rate limits and cleanup | `backend/app/rooms.py` |
| Caddy | Public HTTP/HTTPS entry point, TLS certificates and proxying | `Caddyfile`, `docker-compose.yml` |
| STUN/TURN services | Discover public network routes; relay when direct connectivity fails | ICE settings from environment; provider is external/configurable |

There is no database in this MVP. Room and participant state live in the backend process's memory. No user account or durable movie metadata is stored.

## 5. A connection explained from first principles

Browsers behind routers/firewalls usually cannot accept an arbitrary incoming connection. WebRTC solves real-time media transport, but the peers still need a way to exchange the initial connection details. That setup exchange is called **signaling**.

### Signaling versus media

- **Signaling** is the introduction: WebSocket messages carry SDP session descriptions and ICE candidates between peers through FastAPI.
- **Media transport** is the actual call: after negotiation, WebRTC sends audio/video tracks between browsers, directly when possible.
- **Data channel** is an additional WebRTC peer-to-peer channel for small application messages such as chat and playback requests.

The backend relays the signaling payload but does not interpret the media. Once a WebRTC path exists, the media does not need the application WebSocket to keep flowing.

### SDP, ICE, STUN, and TURN

- **SDP (Session Description Protocol):** describes the proposed media session, codecs, tracks, and connection parameters. Peers exchange offers and answers.
- **ICE (Interactive Connectivity Establishment):** tries candidate network paths to find one that works.
- **STUN:** helps a browser discover its public-facing network address/port so a peer may connect directly.
- **TURN:** relays packets when direct paths cannot be established. This improves connectivity but consumes relay bandwidth and may incur cost.
- `GET /api/ice-config` returns configured ICE servers and optional relay-only policy. `FORCE_RELAY=true` helps test the TURN route.

## 6. Important runtime flows

### Create and join a room

1. The frontend sends `POST /api/rooms`.
2. Backend rate-limits creation by client IP and creates a collision-checked six-character code with a creator token.
3. A browser opens `/ws/{code}` and sends a `join` message with display name and reconnect identity.
4. The room manager enforces room existence, capacity, and join rate limits.
5. The server tells the joining browser its peer ID, whether it is the polite negotiation peer, and current peers; it notifies the other participant.
6. WebSocket messages of type `signal` are relayed to the other room member. `leave`, heartbeat, and room deletion are handled separately.

The code alphabet omits easily confused characters. Room codes are convenience identifiers, not user accounts; creator authorization uses a separate secret token.

### Establish a WebRTC connection

The frontend fetches ICE configuration, creates one `RTCPeerConnection` for the two-person room, and exchanges its descriptions and candidates over signaling. `onnegotiationneeded` supports later track additions, such as starting a movie after the initial connection.

The implementation uses the **perfect negotiation pattern**. The two peers have polite/impolite roles so simultaneous offers do not permanently collide: one side can ignore a colliding offer while the polite side can accept/roll back as needed. This matters because cameras and movie tracks can be added after the initial connection.

### Share a local movie

1. The browser validates the selected file by loading it into a temporary video element and checking metadata/dimensions (and audio tracks when the browser exposes that API).
2. The local player loads the file through an object URL.
3. The streamer plays it and captures the rendered media using `HTMLMediaElement.captureStream()` (Firefox-prefixed fallback exists).
4. Captured video/audio tracks are attached to the peer connection. Negotiation adds these tracks to the WebRTC session.
5. The receiver renders the remote movie stream in its own video element.
6. Sender bitrate and resolution settings are set based on selected 480p/720p/1080p quality.

The sender must decode the file and encode/send it in real time. Browser codec support and sender upload bandwidth therefore matter. The PRD recommends broadly compatible H.264/AAC MP4 or WebM; conversion guidance is provided for incompatible files.

### Playback synchronization

The source file exists only on the streamer's browser. That browser is the **source of truth** for playback. When the viewer asks to play, pause, or seek, the viewer sends a command over the data channel; the streamer applies it to the local video element. The streamer sends playback state back so the viewer can mirror the playing/paused state and display timing information.

This is command synchronization, not two independently hosted copies being kept frame-perfectly aligned. A live WebRTC stream naturally has some latency. The PRD target is a practical low-delay experience, not zero delay.

### Camera, mic, and chat

Camera/microphone are acquired locally through browser media APIs only after the user enables them; they are off by default. Tracks join the same peer connection. Remote camera visibility and remote voice muting can be local viewing choices. Chat is carried by the reliable ordered `control` data channel alongside playback and toggle messages.

## 7. API and message map

| Endpoint/channel | Purpose |
|---|---|
| `GET /api/health` | Liveness check returning `{ "status": "ok" }` |
| `POST /api/rooms` | Create a room; returns code and creator token |
| `GET /api/ice-config` | Provide configured STUN/TURN servers and ICE transport policy |
| `POST /api/ip-report` | Local-only SMTP diagnostic, disabled unless `IP_REPORT_AUTO_LOCAL=true` |
| `WS /ws/{code}` | Join/presence and relay WebRTC signaling; creator can request room deletion |

Typical WebSocket client messages include `join`, `signal`, `ping`, `leave`, and `delete-room`. The server emits join/peer events, room-full/errors, relayed signal messages, and room deletion notifications.

The `control` data channel carries typed messages such as playback commands (`cmd`), playback state (`state`), chat (`chat`), and camera/mic state (`track-toggle`). These are peer-to-peer and do not pass through FastAPI.

## 8. Product requirements (PRD summary)

The detailed product brief lives in [`docs/PRD.md`](PRD.md). Its core requirement groups are:

- **Rooms and presence:** create/join by code or link, two-person maximum, empty-room expiration, reconnect support.
- **Media:** camera/mic off by default; local movie sharing; only one active movie streamer at a time; compatibility feedback; viewer playback controls.
- **Playback:** either participant may request play/pause/seek, with streamer as authority.
- **Communication:** text chat and optional camera/mic.
- **Network experience:** show connection/quality information, recover from temporary disconnects, support TURN fallback.
- **Abuse controls:** rate-limit room creation/join and avoid public room listings.
- **Deployment:** HTTPS/WSS, Docker-based app deployment, externally configured TURN credentials.

### Acceptance-test intent

The PRD/README describe staged acceptance: health/frontend work; two-tab room signaling and third-person rejection; camera/mic; compatible movie and audio; synchronized controls/chat; then cross-network and forced-relay endurance checks. These describe intended validation scenarios, not a claim that every scenario has been performed in production.

## 9. Repository map

```text
backend/app/main.py          FastAPI app assembly
backend/app/api/             HTTP and WebSocket route handlers
backend/app/services/        Client IP resolution and SMTP delivery
backend/app/static_files.py  Production frontend mounting and SPA fallback
backend/app/rooms.py         In-memory room lifecycle and limits
backend/app/config.py        Environment-backed configuration
backend/tests/               Backend room tests
frontend/src/pages/Home.tsx  Create/join entry point
frontend/src/pages/Room.tsx  Room orchestration and app-level state
frontend/src/lib/            Signaling, WebRTC, media, movie, controls
frontend/src/components/     Player, controls, chat, camera, status UI
docs/PRD.md                  Product requirements and design choices
docs/plans/                  Implementation planning notes
docs/logs/ and docs/issues/   Audit/fix notes from development
Dockerfile                   Application image build
docker-compose.yml            App and Caddy services
Caddyfile                    Reverse proxy and HTTPS configuration
```

## 10. Deployment and operations

In development, Vite serves the frontend and proxies API/WebSocket requests to FastAPI. In production, Docker builds the app; FastAPI serves the built frontend, while Caddy sits at the public edge and provides HTTPS/WSS. HTTPS is required for browser camera/microphone access on deployed origins. TURN credentials are supplied through environment configuration rather than bundled into frontend source.

The in-memory room store creates an important scaling constraint: a single app process can coordinate rooms it knows about, but multiple independent replicas would have separate maps. A multi-instance deployment would need shared room/signaling coordination (for example Redis/pub-sub or sticky routing) and deliberate cleanup semantics. This is outside the MVP.

## 11. Constraints, risks, and trade-offs

- **Network reachability:** some network pairs need TURN; a missing/unavailable TURN service can prevent calls.
- **Bandwidth:** the streamer uploads the movie in real time; higher quality needs more upload capacity.
- **CPU:** the streamer browser decodes and transmits the media, which can be demanding, especially at 1080p.
- **Compatibility:** capture support and codecs vary by browser; movie streaming is best supported in desktop Chrome/Edge per README, and Safari has limitations.
- **Autoplay:** browsers may require a user gesture to play remote media with sound.
- **Background tabs:** throttling can affect capture smoothness.
- **Volatile rooms:** process restart loses all in-memory rooms; multiple replicas do not share room state.
- **Capacity:** mesh-style peer-to-peer is suitable for two people; it does not scale efficiently to large groups. An SFU would be the natural later architecture for group rooms.
- **Privacy model:** not uploading to the app server reduces server-side exposure, but peer media still travels over the network and may use a TURN relay. Room codes and rate limits are not a full identity or abuse-prevention system.

## 12. Concepts to know for an interview

### Product and design

- **MVP and scope control:** explain why accounts, recording, subtitles, and group calls were excluded.
- **Functional vs non-functional requirements:** features such as create/join and seek are functional; latency, reliability, privacy, and compatibility are quality attributes.
- **Trade-offs:** lower infrastructure cost/privacy exposure versus browser compatibility, bandwidth dependence, and network complexity.
- **Source of truth:** why the streamer's player executes playback changes.

### Networking and real-time media

- **WebSocket vs WebRTC:** persistent server-mediated signaling versus peer media/data transport.
- **SDP offer/answer and ICE candidates:** how peers describe a session and find a viable route.
- **STUN vs TURN:** address discovery versus packet relay.
- **NAT traversal:** why two devices cannot always connect directly.
- **Perfect negotiation:** resolving simultaneous renegotiation offers.
- **Tracks and streams:** audio/video tracks are negotiated media units; a stream groups tracks for presentation.
- **Data channel:** ordered/reliable application messages independent of the signaling server.
- **Congestion/quality adaptation:** bitrate caps and resolution scaling trade visual quality for sustained playback.

### Backend and reliability

- **In-memory state:** simple and fast for a prototype, volatile and single-process.
- **Room lifecycle and presence:** capacity, disconnects, grace periods, cleanup, reconnection.
- **Rate limiting:** protects room creation/join endpoints from brute force or abuse.
- **Reverse proxy and TLS termination:** Caddy accepts internet traffic, provides certificates, and forwards to the app.
- **Health checks and configuration:** health endpoint and environment-provided ICE credentials.
- **Failure recovery:** WebSocket reconnect, ICE restart, TURN fallback, and their different roles.

### Frontend and browser APIs

- React state versus refs for UI state and long-lived mutable WebRTC objects.
- `getUserMedia`, `MediaStream`, `MediaStreamTrack`, `HTMLMediaElement.captureStream`.
- Object URLs and browser codec/autoplay/security constraints.
- Async event-driven lifecycle management and cleanup of tracks, URLs, sockets, and peer connections.

## 13. A concise interview narrative

> “I built a two-person browser watch party for local video files. The product goal was to let friends watch together without uploading movie files to our backend. FastAPI creates short-lived private rooms and provides WebSocket signaling, while the browsers use WebRTC for peer-to-peer movie, camera, microphone, and data-channel traffic. ICE tries direct connectivity with STUN and falls back to TURN when NAT or firewall rules block it. The streamer browser captures its local video element, and its player is the source of truth for playback requests. The MVP uses in-memory room state to keep the system small, with the known trade-off that it is single-instance and volatile. The hardest areas are browser codec/capture compatibility, negotiation when tracks are added later, NAT traversal, reconnect behavior, and balancing bitrate against upload capacity.”

Use “I” only for work you personally did; otherwise present it as the project design. Be ready to discuss what you implemented, what you tested, and what remains a proposed next step.

## 14. Likely interviewer questions

1. Why is a backend needed if media is peer-to-peer? **Signaling, room membership, and initial rendezvous.**
2. What happens when direct WebRTC connectivity fails? **ICE tries alternatives; TURN relays media if configured.**
3. Does the movie ever reach a server? **Not the application server; a TURN relay may carry encrypted transport packets.**
4. Why is the streamer authoritative? **There is one actual source video element, so commands are applied once and state is mirrored.**
5. How would you support 10 viewers? **Likely introduce an SFU; a peer mesh makes the sender upload one copy per peer.**
6. How would you scale backend instances? **Share signaling/room state or route participants consistently; the current in-memory map is process-local.**
7. What is perfect negotiation solving? **Simultaneous SDP offers during initial setup or later track renegotiation.**
8. What are the primary risks? **TURN availability/cost, upload bandwidth, codec support, autoplay, and reconnect edge cases.**
9. What would you improve next? **Validate end-to-end behavior across real networks/browsers, establish operational TURN, and add shared state only when scaling demands it.**

## 15. Reading order for learning the code

1. Read `README.md` for setup and the short product overview.
2. Read `docs/PRD.md` for the original product scope and design rationale.
3. Follow `frontend/src/pages/Home.tsx` into `frontend/src/pages/Room.tsx` for the user journey and orchestration.
4. Read `frontend/src/lib/signaling.ts`, then `backend/app/api/signaling.py`, `backend/app/services/client_ip.py`, and `backend/app/rooms.py` to understand room signaling.
5. Read `frontend/src/lib/peer.ts` for WebRTC negotiation.
6. Read `frontend/src/lib/movie.ts` and `frontend/src/lib/controls.ts` for movie capture, quality, and playback messages.
7. Inspect `docker-compose.yml`, `Dockerfile`, and `Caddyfile` for deployment.
8. Read `docs/logs/` and `docs/issues/` for concrete implementation lessons and bugs encountered.

## 16. Vocabulary cheat sheet

| Term | Short meaning |
|---|---|
| Peer | One participant's browser in the WebRTC session |
| Signaling | Setup messages that let peers negotiate a connection |
| SDP | Description of the proposed media session |
| ICE candidate | A possible network route for the peers |
| STUN | Service that helps discover a public network endpoint |
| TURN | Relay service used when direct connectivity fails |
| Track | One audio or video source sent over WebRTC |
| Data channel | Peer-to-peer channel for app messages such as chat |
| Renegotiation | Updating SDP after adding/removing media or changing session parameters |
| SFU | Server that forwards media streams for multi-party calls |
| TLS | Encryption/security for HTTPS and WSS connections |

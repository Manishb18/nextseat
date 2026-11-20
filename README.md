# Nextseat

A 2-person browser app for watching local movie files together via WebRTC. The movie streams peer-to-peer — it **never touches the server**. Only signaling messages pass through the backend.

## Features

- 🎬 **Movie streaming** — pick a local MP4/WebM file; the other person sees it live
- 🎥 **Camera + mic** — optional, toggleable, off by default  
- 🕹️ **Synced playback** — pause/seek from either side, streamer is source of truth
- 💬 **Text chat** — over the WebRTC data channel
- 📡 **Connection badge** — live display of direct/relay, bitrate, RTT
- 🔄 **Auto-reconnect** — ICE restart on network drops
- 🔒 **Private rooms** — 6-character codes, max 2 people, rate-limited

## Development Setup

### Prerequisites

- Python 3.11+
- Node.js 20.19+ or 22.12+ and [pnpm](https://pnpm.io)
- Copy `.env.example` → `.env` and fill in TURN credentials if needed

### Backend

```bash
cd backend
pip install -r requirements.txt

# Run the server (use python -m uvicorn — the uvicorn script may not be on PATH)
python -m uvicorn app.main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
pnpm install
pnpm dev
```

The Vite dev server runs at **http://localhost:5173** and proxies `/api/*` and `/ws/*` to the backend on port 8000.

## Testing

### Phase 0 — Health check

```bash
curl http://localhost:8000/api/health
# → {"status":"ok"}
```

### Phase 1 — Two-tab test (Rooms & Signaling)

1. Open `http://localhost:5173` in **Tab A** — enter a name, click **Create Room**, copy the 6-character code.
2. Open `http://localhost:5173` in **Tab B** — enter a name, paste the code, click **Join**.
3. Both tabs should show each other's name.
4. Open **Tab C** with the same code → should see "Room is full".

### Phase 2 — Camera/mic test

1. Both tabs join the same room.
2. Click the 📷 button on Tab A → Tab B should see the camera tile appear.
3. Click 📷 again → tile disappears on Tab B.
4. Try on two **different devices** on the same network.

### Phase 3 — Movie streaming test

1. Both tabs in the same room.
2. Tab A clicks **Share a Movie**, picks a 720p H.264 MP4.
3. Tab B should see the movie playing within 5 seconds, with sound.
4. Tab A picks an MKV with HEVC/AC3 → should see the ffmpeg conversion help message.

### Phase 4 — Controls test

1. Both tabs watching a movie.
2. Tab B (viewer) clicks **Pause** → Tab A's player pauses.
3. Tab A (streamer) seeks to a different position → Tab B jumps to the same time.
4. Change quality dropdown (480p/720p/1080p) → connection badge bitrate updates.
5. Disconnect Wi-Fi for 5 seconds, reconnect → stream should resume automatically.
6. Send chat messages from both sides.

### Phase 5 — Cross-network test

1. Deploy with Docker (see below).
2. Person A on their home network, Person B on a phone hotspot.
3. Watch 10 minutes without a freeze.
4. Set `FORCE_RELAY=true` → connection badge shows "Relay", video still plays.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `STUN_URLS` | `stun:stun.l.google.com:19302` | Comma-separated STUN server URLs |
| `TURN_URLS` | _(empty)_ | Comma-separated TURN server URLs |
| `TURN_USERNAME` | _(empty)_ | TURN username |
| `TURN_CREDENTIAL` | _(empty)_ | TURN password/credential |
| `FORCE_RELAY` | `false` | Set `true` to force all connections through TURN (for testing) |
| `ROOM_CREATE_LIMIT` | `10` | Max room creations per IP per minute |
| `ROOM_JOIN_LIMIT` | `20` | Max join attempts per IP per minute |
| `TRUSTED_PROXY_NETWORKS` | Private network ranges | Networks whose reverse proxies may provide the client IP for rate limiting |
| `SMTP_HOST` / `SMTP_PORT` | _(unset)_ / `587` | SMTP server used by the local IP test email |
| `SMTP_USERNAME` / `SMTP_PASSWORD` | _(unset)_ | SMTP login credentials |
| `SMTP_FROM` / `SMTP_TO` | _(unset)_ | Sender and recipient for the local IP test email |
| `SMTP_USE_SSL` | `false` | Use implicit TLS instead of STARTTLS when connecting to SMTP |
| `IP_REPORT_AUTO_LOCAL` | `false` | Automatically email local development request IPs; non-loopback requests are rejected |

## Docker Deployment

### Build and run locally

```bash
docker compose up --build
```

Serves on port 80 (HTTP). For HTTPS, configure Caddy with your domain (see below).

### Production (with HTTPS)

1. Point your domain's DNS A record to your server's IP.
2. Edit `Caddyfile` — replace `YOUR_DOMAIN` with your domain:

   ```
   watchparty.example.com {
       reverse_proxy @ws app:8000 { ... }
       reverse_proxy app:8000
   }
   ```

3. Create a `.env` file from `.env.example` with your TURN credentials.
4. Run:

   ```bash
   docker compose up -d
   ```

Caddy automatically obtains and renews a Let's Encrypt TLS certificate.

### TURN server options

- **Metered TURN** (free tier, fastest to set up): https://www.metered.ca/tools/openrelay/
- **Cloudflare Calls TURN**: https://developers.cloudflare.com/calls/turn/
- **Self-hosted coturn**: add a `coturn` service to `docker-compose.yml`

## Architecture

```
Browser A                                       Browser B
+---------------+   WebSocket (signaling)   +---------------+
| <video> file  | <──► FastAPI ◄──────────► |               |
| captureStream |       (room map)           |   <video>     |
+-------+-------+                            +-------+-------+
        │          WebRTC peer-to-peer                │
        └──────── movie + cam + mic + data ──────────┘
                 (via TURN relay only if needed)
```

- **Signaling**: WebSocket at `/ws/{code}` — relays SDP and ICE candidates
- **Media**: WebRTC `RTCPeerConnection` with the perfect negotiation pattern
- **Data channel**: one ordered `"control"` channel for play/pause/seek/chat
- **Room codes**: 6-character, no look-alike characters (0/O, 1/I/L excluded)

## Browser Support

| Feature | Chrome/Edge | Firefox | Safari |
|---------|-------------|---------|--------|
| Viewing | ✅ | ✅ | ✅ |
| Camera/mic | ✅ | ✅ | ✅ |
| **Share a Movie** | ✅ | ✅ | ❌ |

> **Note:** Safari does not support `captureStream()` — use Chrome or Edge on desktop to stream a movie. Viewing works in any browser including mobile Safari.

## File Compatibility

The browser can only stream files it can decode. MP4 with H.264 video and AAC audio works everywhere. If your file won't load, convert it:

```bash
# General conversion (re-encodes video)
ffmpeg -i input.mkv -c:v libx264 -c:a aac -movflags +faststart output.mp4

# If video is already H.264 (much faster — just remux)
ffmpeg -i input.mkv -c:v copy -c:a aac output.mp4
```

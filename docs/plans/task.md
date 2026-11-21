| task | status | notes |
| --- | --- | --- |
| Pre-launch: longer invite token (24-char URL-safe secret) | complete | Added invite_token to Room dataclass; join requires correct token; shareable link uses ?t=<token> |
| Pre-launch: host kick and rotate-invite controls | complete | Backend kick_peer + rotate_invite_token; signaling handles kick/rotate-invite messages; frontend kick button + 🔄 New invite button |
| Pre-launch: set MAX_ROOM_PARTICIPANTS = 2 | complete | Changed from 5 → 2 per PRD two-person experience; Home.tsx hero stats updated to '02' |
| Pre-launch: ToS footer + streamer tab-visibility warning | complete | Footer ToS one-liner added; visibilitychange listener shows ⚠️ toast when streamer switches tabs |
| Keep reactions visible over a shared video | complete | Raised the floating reaction layer above the composited player and stabilized its receiver state callback |
| Smooth reaction animation origins | complete | Removed dynamic nth-child positioning and replaced it with one stable launch point and transform-only drift |
| Rebrand the app as Nextseat | complete | Added a custom seat-and-play SVG wordmark, favicon, page title, UI labels, and API title |
| Add connection quality details and troubleshooting | complete | Added live RTT, video bitrate, packet loss, route, quality states, and contextual tips to the connection badge |
| Add copy confirmation feedback | complete | Replaced room invite copy action with reusable success and failure feedback plus subtle motion |
| Verify Nextseat updates | complete | Frontend TypeScript and production build passed |
| Refresh the home dashboard and add a usage guide | complete | Rebuilt the create/join landing experience and added a responsive three-step guide |
| Add peer-to-peer room reactions | complete | Added five emoji reactions over the WebRTC control channel with floating animation for both participants |
| Verify dashboard and reactions implementation | complete | Frontend production build passed with TypeScript and Vite |
| Trace room, signaling, camera, movie, and recovery flows | complete | Confirmed candidate ordering, media lifecycle, and reconnect gaps in source |
| Repair camera and microphone stream behavior | complete | Reuse sender tracks safely, release old tracks, update remote mute state, and play audio-only streams |
| Repair movie playback, replay, and controls | complete | Stable receiver stream ID across replaceTrack, preserve receiver on stop, avoid re-capturing on rerender, and separate viewer live time from the source-file clock |
| Fix camera stop/restart and viewer controls | complete | Honor explicit remote camera toggles, keep one video element mounted across placeholder transitions, report control-channel readiness, and add receiver mute/play/pause controls |
| Add signaling and peer recovery | complete | ICE candidate buffering, guarded sends, bounded socket retry, same-tab identity, and peer-connection rebuild |
| Fix room lifecycle and diagnostics | complete | Expire never-joined rooms, preserve peer identity on socket replacement, and report selected ICE candidate |
| Verify implementation | complete | Frontend build, 7 unit tests, lint, and live two-peer WebSocket reconnect integration passed; browser camera UI test unavailable |

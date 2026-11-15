| task | status | notes |
| --- | --- | --- |
| Trace room, signaling, camera, movie, and recovery flows | complete | Confirmed candidate ordering, media lifecycle, and reconnect gaps in source |
| Repair camera and microphone stream behavior | complete | Reuse sender tracks safely, release old tracks, update remote mute state, and play audio-only streams |
| Repair movie playback, replay, and controls | complete | Stable receiver stream ID across replaceTrack, preserve receiver on stop, avoid re-capturing on rerender, and separate viewer live time from the source-file clock |
| Fix camera stop/restart and viewer controls | complete | Honor explicit remote camera toggles, keep one video element mounted across placeholder transitions, report control-channel readiness, and add receiver mute/play/pause controls |
| Add signaling and peer recovery | complete | ICE candidate buffering, guarded sends, bounded socket retry, same-tab identity, and peer-connection rebuild |
| Fix room lifecycle and diagnostics | complete | Expire never-joined rooms, preserve peer identity on socket replacement, and report selected ICE candidate |
| Verify implementation | complete | Frontend build, 7 unit tests, lint, and live two-peer WebSocket reconnect integration passed; browser camera UI test unavailable |

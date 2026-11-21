# Pre-Launch Hardening Implementation Plan

> **For Antigravity:** REQUIRED WORKFLOW: Use `.agent/workflows/execute-plan.md` to execute this plan in single-flow mode.

**Goal:** Implement the four must-have items before public launch: longer invite token in shareable links, kick peer + rotate invite host controls, 2-person room cap with rationale, and ToS / headphones notice.

**Architecture:** 
- Backend: add `invite_token` (24-char URL-safe) to `Room`, validate on `join_room`, add `kick` and `rotate-invite` signaling messages, set `MAX_ROOM_PARTICIPANTS = 2`.
- Frontend: embed invite token in shareable links, add host control UI (kick button per participant, rotate-invite button), show headphones + ToS notices.

**Tech Stack:** Python/FastAPI backend, React/TypeScript frontend, existing WebSocket signaling channel.

---

## Task 1: Add invite token to Room model and validate on join (backend)

**Files:**
- Modify: `backend/app/rooms.py`
- Modify: `backend/app/api/rooms.py`
- Modify: `backend/app/api/signaling.py`
- Test: `backend/tests/test_rooms.py`

### Step 1: Write failing tests

Add to `backend/tests/test_rooms.py`:

```python
def test_join_requires_invite_token_when_set():
    """Joining without the invite token is rejected after the host sets one."""
    from backend.app.rooms import RoomManager, RoomNotFound
    mgr = RoomManager()
    code = mgr.create_room("1.2.3.4")
    room = mgr.get_room(code)
    # Simulate host joining (sets owner_peer_id)
    import types
    ws = types.SimpleNamespace()
    mgr.join_room(code, ws, "Host", "1.2.3.4", "", room.owner_token)
    # Outsider without invite token is rejected
    ws2 = types.SimpleNamespace()
    with pytest.raises(Exception):
        mgr.join_room(code, ws2, "Stranger", "5.6.7.8")

def test_join_succeeds_with_correct_invite_token():
    from backend.app.rooms import RoomManager
    import types
    mgr = RoomManager()
    code = mgr.create_room("1.2.3.4")
    room = mgr.get_room(code)
    ws = types.SimpleNamespace()
    mgr.join_room(code, ws, "Host", "1.2.3.4", "", room.owner_token)
    ws2 = types.SimpleNamespace()
    # Should succeed with correct invite token
    peer_id, _, _ = mgr.join_room(code, ws2, "Guest", "5.6.7.8", "", "", room.invite_token)
    assert peer_id

def test_room_create_returns_invite_token():
    from backend.app.rooms import RoomManager
    mgr = RoomManager()
    code = mgr.create_room("1.2.3.4")
    room = mgr.get_room(code)
    assert room is not None
    assert len(room.invite_token) >= 24

def test_kick_removes_peer():
    from backend.app.rooms import RoomManager
    import types
    mgr = RoomManager()
    code = mgr.create_room("1.2.3.4")
    room = mgr.get_room(code)
    ws_host = types.SimpleNamespace()
    ws_guest = types.SimpleNamespace()
    mgr.join_room(code, ws_host, "Host", "1.2.3.4", "", room.owner_token)
    # reload room for invite_token
    room = mgr.get_room(code)
    guest_peer_id, _, _ = mgr.join_room(code, ws_guest, "Guest", "5.6.7.8", "", "", room.invite_token)
    removed = mgr.kick_peer(code, ws_host, guest_peer_id)
    assert removed is not None
    assert removed.peer_id == guest_peer_id

def test_rotate_invite_token():
    from backend.app.rooms import RoomManager
    import types
    mgr = RoomManager()
    code = mgr.create_room("1.2.3.4")
    room = mgr.get_room(code)
    ws_host = types.SimpleNamespace()
    mgr.join_room(code, ws_host, "Host", "1.2.3.4", "", room.owner_token)
    old_token = mgr.get_room(code).invite_token
    new_token = mgr.rotate_invite_token(code, ws_host)
    assert new_token is not None
    assert new_token != old_token
```

### Step 2: Run tests to verify they fail

```bash
cd backend && python -m pytest tests/test_rooms.py -v -k "invite_token or kick or rotate" 2>&1
```

Expected: FAIL (invite_token attribute doesn't exist, kick_peer/rotate_invite_token methods don't exist).

### Step 3: Implement backend changes

**`backend/app/rooms.py`** changes:
- Add `invite_token: str` field to `Room` dataclass (generated with `secrets.token_urlsafe(24)`)
- Add `InviteInvalid` exception class
- Change `MAX_ROOM_PARTICIPANTS` from 5 to 2
- In `join_room`: after checking for reconnect by clientId, if the peer is NOT reconnecting and NOT the owner joining their own room (via owner_token), validate `invite_token` matches room's `invite_token`. Specifically: if `len(room.peers) > 0` (room is not empty) and no matching clientId and no owner_token match, check `invite_token`.
- Add `kick_peer(code, ws, target_peer_id) -> Peer | None` method: validates requester is `owner_peer_id`, removes the target, schedules cleanup if empty, returns the removed peer
- Add `rotate_invite_token(code, ws) -> str | None` method: validates requester is `owner_peer_id`, generates new `invite_token`, returns new token or None on failure

**`backend/app/api/rooms.py`** changes:
- Include `inviteToken` in the response alongside `ownerToken`

**`backend/app/api/signaling.py`** changes:
- Accept `inviteToken` from the initial `join` message (alongside `ownerToken`)
- Pass it to `join_room`
- Add `InviteInvalid` to imports and handle with `{type: "invite-invalid"}` response
- Handle `kick` message type: `{type:"kick", targetPeerId}` — call `kick_peer`, if successful close target's ws with 4003
- Handle `rotate-invite` message type: call `rotate_invite_token`, send `{type:"invite-rotated", inviteToken: new_token}` back to requester

### Step 4: Run tests to verify they pass

```bash
cd backend && python -m pytest tests/test_rooms.py -v 2>&1
```

Expected: All tests pass including the 7 existing ones.

### Step 5: Commit

```bash
git add backend/app/rooms.py backend/app/api/rooms.py backend/app/api/signaling.py backend/tests/test_rooms.py
git commit -m "feat: invite token, kick peer, rotate invite, 2-person cap"
```

---

## Task 2: Frontend — invite token in shareable link + NameGate validation

**Files:**
- Modify: `frontend/src/pages/Home.tsx`
- Modify: `frontend/src/pages/Room.tsx`
- Modify: `frontend/src/lib/signaling.ts`

### Step 1: Update SignalingClient to send inviteToken

In `frontend/src/lib/signaling.ts`:
- Add `inviteToken` to `connect(code, name, ownerToken, inviteToken)` signature (default `''`)
- Store `this.inviteToken = inviteToken`
- Include `inviteToken` in the join message sent on `socket.onopen`
- Add `invite-invalid` to `SignalingEvent` union type: `{ type: "invite-invalid" }`
- Add `kicked` to `SignalingEvent` union type: `{ type: "kicked" }`
- Add `invite-rotated` to `SignalingEvent` union type: `{ type: "invite-rotated"; inviteToken: string }`
- Add `kickPeer(targetPeerId: string): boolean` method (sends `{type:"kick", targetPeerId}`)
- Add `rotateInvite(): boolean` method (sends `{type:"rotate-invite"}`)

### Step 2: Update Home.tsx — embed inviteToken in link and pass on navigate

In `frontend/src/pages/Home.tsx`:
- After creating a room, destructure `inviteToken` from the JSON response
- Store `inviteToken` in sessionStorage alongside `ownerToken`: `watch-party-invite:<code>`
- Navigate with `state: { name, ownerToken, inviteToken }`
- In the join form: when navigating to `/r/<code>`, read the invite token from the URL `?t=<token>` if present (the shareable link already has it), or from sessionStorage

### Step 3: Update Room.tsx — handle invite token end-to-end

In `frontend/src/pages/Room.tsx`:
- Extend `LocationState` with `inviteToken?: string`
- Extract `inviteToken` from location state (or from `URLSearchParams` for `?t=` links)
- Pass `inviteToken` to `sigRef.current.connect(code, name, ownerToken, inviteToken)`
- Handle `invite-invalid` signaling event: set status to `'error'` with message "This invite link is no longer valid. Ask the host for a new one."
- Handle `kicked` signaling event: set status to `'error'` with message "You were removed from the room by the host."
- Handle `invite-rotated` event: update the stored invite token in state (for the host's own link display)
- Build the shareable link in the room header as `/r/<code>?t=<inviteToken>` (not just `/r/<code>`)
- When generating the copy-to-clipboard invite text, use the full link with `?t=`

### Step 4: Run build to verify no TypeScript errors

```bash
cd frontend && pnpm build 2>&1
```

Expected: Build succeeds with 0 errors.

### Step 5: Commit

```bash
git add frontend/src/lib/signaling.ts frontend/src/pages/Home.tsx frontend/src/pages/Room.tsx
git commit -m "feat: embed invite token in shareable link, handle invalid invite and kick"
```

---

## Task 3: Host control UI — kick participant, rotate invite

**Files:**
- Modify: `frontend/src/pages/Room.tsx`

### Step 1: Add host controls to participant panel

In `RoomInner` component (Room.tsx), find the participant panel / sidebar area where `roomParticipants` is rendered. Currently participants are listed; add host-only controls:

**Kick button per participant** (only shown when `isCreator` and participant is not self):
```tsx
{isCreator && p.peerId !== localPeerIdRef.current && (
  <button
    onClick={() => handleKick(p.peerId)}
    className="ml-auto rounded px-2 py-0.5 text-xs text-rose-400 hover:bg-rose-900/40 hover:text-rose-300 transition"
    title={`Remove ${p.name} from room`}
  >
    Remove
  </button>
)}
```

**Rotate invite button** (only shown when `isCreator`):
- Add state: `const [inviteToken, setInviteToken] = useState(locationState?.inviteToken ?? '')`
- Add a "🔄 New invite link" button in the room header area next to the existing copy button, visible only to host
- On click: call `sigRef.current?.rotateInvite()`, show a "Rotating…" spinner until `invite-rotated` arrives, then update `inviteToken` state and trigger the existing copy-link feedback

**`handleKick` function:**
```ts
function handleKick(targetPeerId: string) {
  sigRef.current?.kickPeer(targetPeerId);
}
```

**Handle `kicked` and `invite-rotated` in the signaling event handler** (find the big `switch/if-else` on `event.type` in the useEffect):
```ts
} else if (event.type === 'kicked') {
  setStatus('error');
  setErrorMsg('You were removed from the room by the host.');
} else if (event.type === 'invite-rotated') {
  setInviteToken(event.inviteToken);
  // Persist so page refresh works
  try { sessionStorage.setItem(`watch-party-invite:${code}`, event.inviteToken); } catch { /* ok */ }
}
```

### Step 2: Run build to verify no TypeScript errors

```bash
cd frontend && pnpm build 2>&1
```

Expected: Build succeeds.

### Step 3: Commit

```bash
git add frontend/src/pages/Room.tsx
git commit -m "feat: host kick and rotate-invite UI controls"
```

---

## Task 4: Streamer tab-visibility warning, headphones notice, ToS footer

**Files:**
- Modify: `frontend/src/pages/Room.tsx` (tab visibility warning for streamers)
- Modify: `frontend/src/pages/Home.tsx` (headphones notice, ToS footer)

### Step 1: Tab visibility warning for streamer

In `RoomInner`, add a `tabHidden` state and listener:

```ts
const [tabHidden, setTabHidden] = useState(false);
useEffect(() => {
  const handler = () => setTabHidden(document.hidden);
  document.addEventListener('visibilitychange', handler);
  return () => document.removeEventListener('visibilitychange', handler);
}, []);
```

Show a toast/banner only when `isStreaming && tabHidden`:
```tsx
{isStreaming && tabHidden && (
  <div role="alert" className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 rounded-xl bg-amber-900/90 border border-amber-500/40 px-5 py-3 text-sm font-medium text-amber-200 shadow-xl backdrop-blur flex items-center gap-2">
    <span>⚠️</span> Keep this tab visible — minimizing may stutter the stream.
  </div>
)}
```

### Step 2: Headphones notice on Home.tsx join card

The existing notice at the bottom of the join card reads:
> "Headphones help avoid echo. Movie and camera video go directly between browsers. This app doesn't upload or store them."

This is already there! Verify it's present and visible — no change needed. ✓

### Step 3: ToS footer on Home.tsx

The existing footer reads:
> "Made for nights in, together." / "Private rooms · peer-to-peer video · up to five people"

Change the footer to include a ToS note and update the participant count:

```tsx
<footer className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.08] py-5 text-xs text-slate-600">
  <span>Made for nights in, together.</span>
  <span>Private rooms · peer-to-peer · 2 people per room</span>
  <span>Users are responsible for the content they share.</span>
</footer>
```

Also update the stats grid: change `'05'` to `'02'` and `'people per room'` label, and update the hero subtitle from "Rooms hold up to five people" to "Rooms are private, two-person, peer-to-peer."

Update `steps[1]` detail: change "Up to five people connect directly" → "Two people connect directly".

### Step 4: Run build

```bash
cd frontend && pnpm build 2>&1
```

Expected: Build succeeds, no TypeScript errors.

### Step 5: Run all backend tests

```bash
cd backend && python -m pytest tests/ -v 2>&1
```

Expected: All tests pass.

### Step 6: Commit

```bash
git add frontend/src/pages/Room.tsx frontend/src/pages/Home.tsx
git commit -m "feat: tab-visibility warning for streamer, ToS footer, 2-person copy"
```

---

## Final verification

```bash
cd backend && python -m pytest tests/ -v
cd frontend && pnpm build
```

Both must pass cleanly before claiming done.

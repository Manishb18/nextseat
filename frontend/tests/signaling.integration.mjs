const backend = process.env.WATCH_PARTY_BACKEND ?? 'http://localhost:8000';
const origin = new URL(backend);

async function waitForMessage(socket, predicate, timeoutMs = 4_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener('message', onMessage);
      reject(new Error('Timed out waiting for signaling message'));
    }, timeoutMs);
    function onMessage(event) {
      const message = JSON.parse(event.data);
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.removeEventListener('message', onMessage);
      resolve(message);
    }
    socket.addEventListener('message', onMessage);
  });
}

async function connect(code, clientId, name) {
  const protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${origin.host}/ws/${code}`);
  const joined = waitForMessage(socket, (message) => message.type === 'joined' || message.type === 'error');
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.send(JSON.stringify({ type: 'join', name, clientId }));
  const result = await joined;
  if (result.type !== 'joined') throw new Error(`Room join failed: ${result.message}`);
  return { socket, joined: result };
}

const roomResponse = await fetch(`${backend}/api/rooms`, { method: 'POST' });
if (!roomResponse.ok) throw new Error(`Room creation failed: ${roomResponse.status}`);
const { code } = await roomResponse.json();
const firstId = crypto.randomUUID();
const secondId = crypto.randomUUID();
let first;
let second;

try {
  first = await connect(code, firstId, 'First');
  const firstPeerJoined = waitForMessage(first.socket, (message) => message.type === 'peer-joined');
  second = await connect(code, secondId, 'Second');
  await firstPeerJoined;

  const reconnectedEvent = waitForMessage(second.socket, (message) => message.type === 'peer-reconnected');
  const replacement = await connect(code, firstId, 'First');
  const reconnected = await reconnectedEvent;
  if (replacement.joined.peerId !== first.joined.peerId || reconnected.peerId !== first.joined.peerId) {
    throw new Error('Reconnect did not preserve the original peer identity');
  }

  const relayedSignal = waitForMessage(second.socket, (message) => message.type === 'signal');
  replacement.socket.send(JSON.stringify({ type: 'signal', data: { probe: 'reconnected' } }));
  const signal = await relayedSignal;
  if (signal.data.probe !== 'reconnected') throw new Error('Signal did not relay after reconnect');

  console.log('PASS: two peers joined, signaling reconnected, and signals relayed');
  replacement.socket.close();
} finally {
  first?.socket.close();
  second?.socket.close();
}

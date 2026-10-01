// Signaling server protocol tests (no browser).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { io } = require('socket.io-client');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3600 + Math.floor(Math.random() * 300);
const URL = `http://127.0.0.1:${PORT}`;
const clients = [];

before(async () => {
  process.env.listen_port = String(PORT);
  process.env.listen_ip = '127.0.0.1';
  // Own ice file so the result does not depend on a local iceservers.json.
  process.env.ICESERVERS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ice-')), 'ice.json');
  fs.writeFileSync(process.env.ICESERVERS_FILE, JSON.stringify([
    { url: 'stun:legacy.example:3478' },
    { urls: 'turn:turn.example:3478', username: 'bob', turnServerCredential: 's3cret' },
  ]));
  require('../server.js'); // ponytail: in-process, runner exits via --test-force-exit
});
after(() => clients.forEach(c => c.close()));

async function client(uuid, key = uuid + '-key') {
  const c = io(URL, { transports: ['websocket'], reconnection: false });
  clients.push(c);
  await new Promise(r => c.on('connect', r));
  const [err, already] = await new Promise(r => c.emit('registerUUID', { UUID: uuid, UUID_KEY: key }, (...a) => r(a)));
  return { c, err, already };
}
async function join(cl, roomname, username = 'u') {
  const joined = nextEvent(cl.c, 'msg'); // a socket's events are handled in order: the echo means the join is done
  cl.c.emit('joinRoom', { roomname, username });
  cl.c.emit('sendMsg', 'joined');
  await joined;
}
const nextEvent = (c, ev, ms = 1000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`no '${ev}' within ${ms}ms`)), ms);
  c.once(ev, d => { clearTimeout(t); res(d); });
});

test('signaling is routed to the destination UUID', async () => {
  const a = await client('A1'), b = await client('B1');
  await join(a, 'room-a'); await join(b, 'room-a');
  const got = nextEvent(b.c, 'signaling');
  a.c.emit('signaling', { destUUID: 'B1', signalingData: { type: 'offer', sdp: 'x' } });
  assert.deepStrictEqual((await got).signalingData, { type: 'offer', sdp: 'x' });
  assert.strictEqual((await got).fromUUID, 'A1');
});

test('UUID cannot be hijacked with a wrong key', async () => {
  await client('H1', 'secret');
  const { err } = await client('H1', 'guess');
  assert.ok(err, 'second registration with a different key must be rejected');
});

test('stale socket disconnect does not unregister the reconnected socket', async () => {
  // Client reconnects (new socket) before the server noticed the old one died.
  const old = await client('R1');
  const fresh = await client('R1');
  assert.strictEqual(fresh.err, null);
  old.c.close(); // server now sees the *old* socket disconnect
  await new Promise(r => setTimeout(r, 200));
  await join(fresh, 'room-r');
  const sender = await client('S1');
  await join(sender, 'room-r');
  const got = nextEvent(fresh.c, 'signaling');
  sender.c.emit('signaling', { destUUID: 'R1', signalingData: 'hi' });
  await got;
});

test('ICE servers: legacy "url" becomes "urls", TURN gets HMAC credentials', async () => {
  const c = io(URL, { transports: ['websocket'], reconnection: false });
  clients.push(c);
  const [stun, turn] = await nextEvent(c, 'currentIceServers');
  assert.deepStrictEqual(stun, { urls: 'stun:legacy.example:3478' });
  assert.strictEqual(turn.urls, 'turn:turn.example:3478');
  assert.ok(!('turnServerCredential' in turn), 'secret must not leak');
  const [expiry, name] = turn.username.split(':');
  assert.strictEqual(name, 'bob');
  assert.ok(+expiry > Date.now() / 1000, 'expiry in the future');
  assert.strictEqual(turn.credential, crypto.createHmac('sha1', 's3cret').update(turn.username).digest('base64'));
});

test('room members get userJoined / userDiscconected', async () => {
  const a = await client('J1'), b = await client('J2');
  a.c.emit('joinRoom', { roomname: 'room-j', username: 'a' });
  const echoed = nextEvent(a.c, 'msg'); // server handles a socket's events in order:
  a.c.emit('sendMsg', 'x');             // the echo means a's join is done
  await echoed;
  const joined = nextEvent(a.c, 'userJoined');
  b.c.emit('joinRoom', { roomname: 'room-j', username: 'b' });
  assert.deepStrictEqual(await joined, { UUID: 'J2' });
  const left = nextEvent(a.c, 'userDiscconected');
  b.c.close();
  assert.strictEqual(await left, 'J2');
});

test('malformed payloads are ignored and signaling keeps working', async () => {
  const a = await client('M1'), b = await client('M2');
  a.c.emit('signaling', null);
  a.c.emit('joinRoom', null);
  a.c.emit('registerUUID', null);
  a.c.emit('registerUUID', null, () => { });
  a.c.emit('registerUUID', { UUID: 'M9', UUID_KEY: 'k' }); // no ack callback
  a.c.emit('currentAudioLvl', null);
  await new Promise(r => setTimeout(r, 100));
  await join(a, 'room-m', { evil: 1 }); await join(b, 'room-m');
  const got = nextEvent(b.c, 'signaling');
  a.c.emit('signaling', { destUUID: 'M2', signalingData: 'hi' });
  const d = await got;
  assert.strictEqual(d.fromUUID, 'M1');
  assert.strictEqual(typeof d.username, 'string');
});

test('only well-formed UUIDs are accepted, one per socket', async () => {
  assert.ok((await client('bad uuid!')).err);
  assert.ok((await client('x'.repeat(65))).err);
  const a = await client('O1');
  const [err] = await new Promise(r => a.c.emit('registerUUID', { UUID: 'O2', UUID_KEY: 'k' }, (...x) => r(x)));
  assert.ok(err, 'second UUID on the same socket must be rejected');
});

test('signaling is not routed across rooms', async () => {
  const a = await client('X1'), b = await client('X2');
  await join(a, 'room-x1'); await join(b, 'room-x2');
  const got = nextEvent(b.c, 'signaling', 300);
  a.c.emit('signaling', { destUUID: 'X2', signalingData: 'hi' });
  await assert.rejects(got);
});

test('a second joinRoom cannot switch rooms', async () => {
  const a = await client('W1'), spy = await client('W2');
  await join(a, 'room-w1'); await join(spy, 'room-w2');
  const seen = [];
  spy.c.on('msg', m => seen.push(m));
  a.c.emit('joinRoom', { roomname: 'room-w2', username: 'mallory' });
  const echo = nextEvent(a.c, 'msg');
  a.c.emit('sendMsg', 'leak');
  assert.strictEqual(await echo, 'u: leak', 'name unchanged');
  await new Promise(r => setTimeout(r, 200)); // nothing to wait for: asserting something does not arrive
  assert.deepStrictEqual(seen, []);
});

test('an empty room name still allows signaling', async () => {
  const a = await client('E1'), b = await client('E2');
  await join(a, ''); await join(b, '');
  const got = nextEvent(b.c, 'signaling');
  a.c.emit('signaling', { destUUID: 'E2', signalingData: 'hi' });
  assert.strictEqual((await got).signalingData, 'hi');
});

// Signaling server protocol tests (no browser).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { io } = require('socket.io-client');

const PORT = 3600 + Math.floor(Math.random() * 300);
const URL = `http://127.0.0.1:${PORT}`;
const clients = [];

before(async () => {
  process.env.listen_port = String(PORT);
  process.env.listen_ip = '127.0.0.1';
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
const nextEvent = (c, ev, ms = 1000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`no '${ev}' within ${ms}ms`)), ms);
  c.once(ev, d => { clearTimeout(t); res(d); });
});

test('signaling is routed to the destination UUID', async () => {
  const a = await client('A1'), b = await client('B1');
  const got = nextEvent(b.c, 'signaling');
  a.c.emit('signaling', { destUUID: 'B1', signalingData: { type: 'offer', sdp: 'x' } });
  assert.deepStrictEqual((await got).signalingData, { type: 'offer', sdp: 'x' });
  assert.strictEqual((await got).fromUUID, 'A1');
});

test('UUID cannot be hijacked with a wrong key', { todo: 'BUG: server reads UUID_KEY from content.UUID' }, async () => {
  await client('H1', 'secret');
  const { err } = await client('H1', 'guess');
  assert.ok(err, 'second registration with a different key must be rejected');
});

test('stale socket disconnect does not unregister the reconnected socket', { todo: 'BUG: disconnect deletes mapping without checking socket.id' }, async () => {
  // Client reconnects (new socket) before the server noticed the old one died.
  const old = await client('R1');
  const fresh = await client('R1');
  assert.strictEqual(fresh.err, null);
  old.c.close(); // server now sees the *old* socket disconnect
  await new Promise(r => setTimeout(r, 200));
  const sender = await client('S1');
  const got = nextEvent(fresh.c, 'signaling');
  sender.c.emit('signaling', { destUUID: 'R1', signalingData: 'hi' });
  await got;
});

test('room members get userJoined / userDiscconected', async () => {
  const a = await client('J1'), b = await client('J2');
  a.c.emit('joinRoom', { roomname: 'room-j', username: 'a' });
  await new Promise(r => setTimeout(r, 100));
  const joined = nextEvent(a.c, 'userJoined');
  b.c.emit('joinRoom', { roomname: 'room-j', username: 'b' });
  assert.deepStrictEqual(await joined, { UUID: 'J2' });
  const left = nextEvent(a.c, 'userDiscconected');
  b.c.close();
  assert.strictEqual(await left, 'J2');
});

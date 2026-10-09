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
  process.env.ROOM_GRACE_MS = '300'; // how long an emptied room keeps its lock
  // Own ice file so the result does not depend on a local iceservers.json.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ice-'));
  process.env.ICESERVERS_FILE = path.join(dir, 'ice.json');
  fs.writeFileSync(process.env.ICESERVERS_FILE, JSON.stringify([
    { url: 'stun:legacy.example:3478' },
    { urls: 'turn:turn.example:3478', username: 'bob', turnServerCredential: 's3cret' },
  ]));
  require('../server.js'); // ponytail: in-process, runner exits via --test-force-exit
  fs.rmSync(dir, { recursive: true }); // read synchronously at startup
});
after(() => clients.forEach(c => c.close()));

async function client(uuid, key = uuid + '-key') {
  const c = io(URL, { transports: ['websocket'], reconnection: false });
  clients.push(c);
  await new Promise(r => c.on('connect', r));
  const [err, already] = await new Promise(r => c.emit('registerUUID', { UUID: uuid, UUID_KEY: key }, (...a) => r(a)));
  return { c, err, already, uuid, key };
}
async function join(cl, roomname) {
  cl.c.emit('joinRoom', { roomname });
  await sync(cl);
}
// A socket's events are handled in order: the ack of a repeated registerUUID means all earlier ones are done.
const sync = cl => new Promise(r => cl.c.emit('registerUUID', { UUID: cl.uuid, UUID_KEY: cl.key }, r));
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
  await join(a, 'room-j');
  const joined = nextEvent(a.c, 'userJoined');
  b.c.emit('joinRoom', { roomname: 'room-j' });
  assert.deepStrictEqual(await joined, { UUID: 'J2', keep: [] });
  const left = nextEvent(a.c, 'userDiscconected');
  b.c.close();
  assert.strictEqual(await left, 'J2');
});

test('userJoined forwards the rejoining peer\'s keep list, strings only, at most 8', async () => {
  const a = await client('K1'), b = await client('K2');
  await join(a, 'room-k');
  const joined = nextEvent(a.c, 'userJoined');
  b.c.emit('joinRoom', { roomname: 'room-k', keep: ['K1', { toString: 1 }, 5, ...'abcdefghij'] });
  assert.deepStrictEqual(await joined, { UUID: 'K2', keep: ['K1', ...'abcdefg'] });
  const c = await client('K3');
  const again = nextEvent(a.c, 'userJoined');
  c.c.emit('joinRoom', { roomname: 'room-k', keep: 'K1' });
  assert.deepStrictEqual(await again, { UUID: 'K3', keep: [] });
});

test('joinRoom acks with the UUIDs already in the room', async () => {
  const a = await client('Q1'), b = await client('Q2'), other = await client('Q3');
  await join(a, 'room-q'); await join(other, 'room-q2');
  const members = await b.c.timeout(1000).emitWithAck('joinRoom', { roomname: 'room-q' });
  assert.deepStrictEqual(members, ['Q1']);
});

test('malformed payloads are ignored and signaling keeps working', async () => {
  const a = await client('M1'), b = await client('M2');
  a.c.emit('signaling', null);
  a.c.emit('joinRoom', null);
  a.c.emit('registerUUID', null);
  a.c.emit('registerUUID', null, () => { });
  a.c.emit('registerUUID', { UUID: 'M9', UUID_KEY: 'k' }); // no ack callback
  a.c.emit('joinRoom', { roomname: { toString: 1 } }); // String() of it would throw
  await sync(a); await join(b, '');
  const got = nextEvent(b.c, 'signaling');
  a.c.emit('signaling', { destUUID: 'M2', signalingData: 'hi' });
  assert.strictEqual((await got).fromUUID, 'M1');
});

test('chat, mic levels and usernames do not go through the server (#11)', async () => {
  const a = await client('P1'), b = await client('P2');
  await join(a, 'room-p'); await join(b, 'room-p');
  const seen = [];
  b.c.onAny(ev => seen.push(ev));
  a.c.emit('sendMsg', 'secret'); a.c.emit('currentAudioLvl', 2);
  const got = nextEvent(b.c, 'signaling');
  a.c.emit('signaling', { destUUID: 'P2', signalingData: 'hi' });
  assert.ok(!('username' in await got), 'no username in signaling');
  assert.deepStrictEqual(seen, ['signaling']);
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
  a.c.emit('joinRoom', { roomname: 'room-w2' });
  const got = nextEvent(spy.c, 'signaling', 300);
  a.c.emit('signaling', { destUUID: 'W2', signalingData: 'leak' });
  await assert.rejects(got);
});

test('an empty room name still allows signaling', async () => {
  const a = await client('E1'), b = await client('E2');
  await join(a, ''); await join(b, '');
  const got = nextEvent(b.c, 'signaling');
  a.c.emit('signaling', { destUUID: 'E2', signalingData: 'hi' });
  assert.strictEqual((await got).signalingData, 'hi');
});

test('joinRoom before registerUUID is ignored', async () => {
  const a = await client('U1');
  await join(a, 'room-u');
  const ghost = io(URL, { transports: ['websocket'], reconnection: false });
  clients.push(ghost);
  await new Promise(r => ghost.on('connect', r));
  const got = nextEvent(a.c, 'userJoined', 300);
  ghost.emit('joinRoom', { roomname: 'room-u', username: 'g' });
  await assert.rejects(got, 'no peer connection for a null UUID');
});

test('Object.prototype names are ordinary UUIDs', async () => {
  // Held by a real owner, the key must not be guessable from Object.prototype.
  assert.strictEqual((await client('__proto__')).err, null);
  assert.ok((await client('__proto__', '[object Object]')).err);
  assert.strictEqual((await client('constructor')).err, null);
  assert.ok((await client('constructor', 'function Object() { [native code] }')).err);
  assert.strictEqual((await client('hasOwnProperty')).err, null);
  assert.strictEqual((await client('toString')).err, null);
});

test('signaling from an unregistered socket is ignored', async () => {
  const a = await client('U2');
  await join(a, 'room-u2');
  const ghost = io(URL, { transports: ['websocket'], reconnection: false });
  clients.push(ghost);
  await new Promise(r => ghost.on('connect', r));
  const got = nextEvent(a.c, 'signaling', 300);
  ghost.emit('joinRoom', { roomname: 'room-u2', username: 'g' });
  ghost.emit('signaling', { destUUID: 'U2', signalingData: 'hi' });
  await assert.rejects(got);
});

// Closed room: a member locks it, newcomers knock, any member admits or rejects.
const ack = (cl, ev, data) => cl.c.timeout(1000).emitWithAck(ev, data);
const quiet = (c, ev, ms = 300) => new Promise((res, rej) => { // ev must NOT arrive
  const f = () => rej(new Error(`unexpected '${ev}'`));
  c.once(ev, f); setTimeout(() => { c.off(ev, f); res(); }, ms);
});

test('locked room: a knocker stays out until a member admits it', async () => {
  const a = await client('L1'), b = await client('L2'), c = await client('L3');
  await join(a, 'room-l');
  const locked = nextEvent(a.c, 'locked');
  a.c.emit('setLocked', true, 'alice');
  assert.deepStrictEqual(await locked, { locked: true, by: 'L1', name: 'alice' });
  const knock = nextEvent(a.c, 'knock');
  assert.deepStrictEqual(await ack(b, 'joinRoom', { roomname: 'room-l', name: 'bob', knockId: 'kb' }), { wait: 0 });
  assert.deepStrictEqual(await knock, { UUID: 'L2', name: 'bob' });
  const noSignal = quiet(a.c, 'signaling');
  b.c.emit('signaling', { destUUID: 'L1', signalingData: 'hi' }); // not in the room yet
  await noSignal;
  await ack(c, 'joinRoom', { roomname: 'room-l', name: 'carol' }); // a second knocker, still waiting
  const answer = nextEvent(b.c, 'knockAnswer'), done = nextEvent(a.c, 'knockDone');
  a.c.emit('answerKnock', { UUID: 'L2', accept: true });
  assert.deepStrictEqual(await answer, { accept: true });
  assert.strictEqual(await done, 'L2');
  const joined = nextEvent(a.c, 'userJoined'), bLocked = nextEvent(b.c, 'locked'), bKnock = nextEvent(b.c, 'knock');
  assert.deepStrictEqual(await ack(b, 'joinRoom', { roomname: 'room-l' }), ['L1']);
  assert.strictEqual((await joined).UUID, 'L2');
  assert.deepStrictEqual(await bLocked, { locked: true }, 'new member sees the lock');
  assert.deepStrictEqual(await bKnock, { UUID: 'L3', name: 'carol' }, 'and the knocks still waiting');
  const cDone = nextEvent(b.c, 'knockDone');
  c.c.close();
  assert.strictEqual(await cDone, 'L3', 'a knocker that leaves is taken off the list');
});

test('rejected knocks wait 15s, doubling with each reject, also after a reload', async () => {
  const a = await client('W1');
  await join(a, 'room-w');
  a.c.emit('setLocked', true);
  await sync(a);
  const now = Date.now;
  let t = now();
  Date.now = () => t;
  try {
    for (const [i, wait] of [[1, 15], [2, 30], [3, 60]]) {
      const b = await client('W2-' + i); // a reload is a new UUID, same tab = same knockId
      const knock = nextEvent(a.c, 'knock');
      assert.deepStrictEqual(await ack(b, 'joinRoom', { roomname: 'room-w', name: 'bob', knockId: 'kw' }), { wait: 0 });
      await knock;
      const answer = nextEvent(b.c, 'knockAnswer');
      a.c.emit('answerKnock', { UUID: 'W2-' + i, accept: false });
      assert.deepStrictEqual(await answer, { wait });
      const noKnock = quiet(a.c, 'knock');
      t += (wait - 1) * 1000;
      assert.deepStrictEqual(await ack(b, 'joinRoom', { roomname: 'room-w', name: 'bob', knockId: 'kw' }), { wait: 1 }, 'still cooling down');
      await noKnock;
      t += 1000;
      b.c.close();
    }
  } finally { Date.now = now; }
});

test('only room members can lock and answer knocks', async () => {
  const a = await client('O1'), b = await client('O2'), out = await client('O3');
  await join(a, 'room-o'); await join(out, 'room-o2');
  out.c.emit('setLocked', true); // member of another room
  await sync(out);
  assert.deepStrictEqual(await ack(b, 'joinRoom', { roomname: 'room-o' }), ['O1'], 'room-o not locked by an outsider');
  a.c.emit('setLocked', true);
  const c = await client('O4');
  const knock = nextEvent(a.c, 'knock');
  await ack(c, 'joinRoom', { roomname: 'room-o', name: 'x' });
  await knock;
  const noAnswer = quiet(c.c, 'knockAnswer');
  out.c.emit('answerKnock', { UUID: 'O4', accept: true });
  await noAnswer;
  for (const bad of [null, 'yes', 1]) a.c.emit('setLocked', bad);
  out.c.emit('answerKnock', null);
  await sync(a);
});

test('members rejoin a locked room without knocking, also after a reload of their tab', async () => {
  const a = await client('E1'), b = await client('E2');
  await ack(a, 'joinRoom', { roomname: 'room-e', knockId: 'tab-a' }); await ack(b, 'joinRoom', { roomname: 'room-e', knockId: 'tab-b' });
  a.c.emit('setLocked', true);
  await sync(a);
  b.c.close(); // socket drops, page reconnects with the same UUID
  await new Promise(r => setTimeout(r, 100));
  const b2 = await client('E2');
  assert.deepStrictEqual(await ack(b2, 'joinRoom', { roomname: 'room-e', knockId: 'tab-b' }), ['E1'], 'no knock after a reconnect');
  b2.c.close(); // reload: new UUID, same tab
  const b3 = await client('E2-reloaded');
  assert.deepStrictEqual(await ack(b3, 'joinRoom', { roomname: 'room-e', knockId: 'tab-b' }), ['E1'], 'no knock after a reload');
  const k = await client('E3');
  assert.deepStrictEqual(await ack(k, 'joinRoom', { roomname: 'room-e', knockId: 'tab-a' + 'x' }), { wait: 0 }, 'other tabs knock');
});

test('a briefly empty room keeps its lock; only a room empty for a while opens', async () => {
  const a = await client('G1');
  await ack(a, 'joinRoom', { roomname: 'room-g', knockId: 'tab-g' });
  a.c.emit('setLocked', true);
  await sync(a);
  const k = await client('G2');
  assert.deepStrictEqual(await ack(k, 'joinRoom', { roomname: 'room-g', name: 'k' }), { wait: 0 });
  const noAnswer = quiet(k.c, 'knockAnswer', 150);
  a.c.close(); // the only member reloads
  await noAnswer;
  const a2 = await client('G1-reloaded');
  const knock = nextEvent(a2.c, 'knock');
  assert.deepStrictEqual(await ack(a2, 'joinRoom', { roomname: 'room-g', knockId: 'tab-g' }), [], 'back in without knocking');
  assert.strictEqual((await knock).UUID, 'G2', 'knock still waiting, now shown to the member');
  await new Promise(r => setTimeout(r, 500)); // past the grace time: room not empty, still locked
  const k2 = await client('G3');
  assert.deepStrictEqual(await ack(k2, 'joinRoom', { roomname: 'room-g' }), { wait: 0 });
  const retry = nextEvent(k.c, 'knockAnswer', 2000);
  a2.c.close();
  assert.deepStrictEqual(await retry, { accept: true }, 'empty for a while: open again, knockers sent in');
  assert.deepStrictEqual(await ack(k, 'joinRoom', { roomname: 'room-g' }), []);
});

test('a knock is shown once per knocker, at most 5 wait at a time', async () => {
  const a = await client('N1');
  await join(a, 'room-n');
  a.c.emit('setLocked', true);
  await sync(a);
  const seen = [];
  a.c.on('knock', k => seen.push(k.UUID));
  const k = await client('N2');
  for (let i = 0; i < 5; i++) await ack(k, 'joinRoom', { roomname: 'room-n', name: 'spam' + i });
  for (let i = 3; i < 7; i++) assert.deepStrictEqual(await ack(await client('N' + i), 'joinRoom', { roomname: 'room-n' }), { wait: 0 });
  assert.deepStrictEqual(await ack(await client('N7'), 'joinRoom', { roomname: 'room-n' }), { wait: 15 }, 'door full');
  await sync(a);
  assert.deepStrictEqual(seen, ['N2', 'N3', 'N4', 'N5', 'N6']);
});

test('unlocking lets the waiting knockers in', async () => {
  const a = await client('UL1'), k = await client('UL2');
  await join(a, 'room-ul');
  a.c.emit('setLocked', true);
  await sync(a);
  await ack(k, 'joinRoom', { roomname: 'room-ul' });
  const answer = nextEvent(k.c, 'knockAnswer'), done = nextEvent(a.c, 'knockDone');
  a.c.emit('setLocked', false);
  assert.deepStrictEqual(await answer, { accept: true });
  assert.strictEqual(await done, 'UL2');
  assert.deepStrictEqual(await ack(k, 'joinRoom', { roomname: 'room-ul' }), ['UL1']);
});

test('no CORS headers for other origins', async () => {
  const headers = { Origin: 'https://evil.example' };
  const poll = await fetch(`${URL}/socket.io/?EIO=4&transport=polling`, { headers });
  assert.strictEqual(poll.headers.get('access-control-allow-origin'), null);
});

test('the first one in can open the room closed; later joiners cannot lock it this way', async () => {
  const a = await client('F1'), b = await client('F2'), c = await client('F3');
  assert.deepStrictEqual(await ack(a, 'roomInfo', 'room-f'), { empty: true });
  const locked = nextEvent(a.c, 'locked');
  assert.deepStrictEqual(await ack(a, 'joinRoom', { roomname: 'room-f', lock: true }), []);
  assert.deepStrictEqual(await locked, { locked: true });
  assert.deepStrictEqual(await ack(b, 'roomInfo', 'room-f'), { empty: false });
  assert.deepStrictEqual(await ack(b, 'joinRoom', { roomname: 'room-f' }), { wait: 0 }, 'newcomer knocks');

  await join(c, 'room-fo'); // open room with a member
  const d = await client('F4');
  assert.deepStrictEqual(await ack(d, 'joinRoom', { roomname: 'room-fo', lock: true }), ['F3']);
  assert.deepStrictEqual(await ack(await client('F5'), 'joinRoom', { roomname: 'room-fo' }), ['F3', 'F4'], 'still open');
});

test('a locked room that just emptied is not offered as empty', async () => {
  const a = await client('GE1'), b = await client('GE2');
  await ack(a, 'joinRoom', { roomname: 'room-ge', lock: true });
  a.c.close();
  await new Promise(r => setTimeout(r, 50));
  assert.deepStrictEqual(await ack(b, 'roomInfo', 'room-ge'), { empty: false }, 'still locked in the grace time');
  await new Promise(r => setTimeout(r, 500)); // past the grace time: forgotten, open again
  assert.deepStrictEqual(await ack(b, 'roomInfo', 'room-ge'), { empty: true });
});

test('an earlier emptying does not cut the grace time short (#54)', async () => {
  const x = await client('GT1'), y = await client('GT2'), s = await client('GT3');
  await join(x, 'room-gt');
  x.c.close(); // room empty: grace time starts
  await new Promise(r => setTimeout(r, 150));
  const locked = nextEvent(y.c, 'locked');
  assert.deepStrictEqual(await ack(y, 'joinRoom', { roomname: 'room-gt', lock: true }), [], 'first in again');
  await locked;
  await new Promise(r => setTimeout(r, 100));
  y.c.close(); // a reload: empty again, a fresh grace time
  await new Promise(r => setTimeout(r, 150)); // past the first grace time, not the second
  assert.deepStrictEqual(await ack(s, 'roomInfo', 'room-gt'), { empty: false }, 'lock kept');
  await new Promise(r => setTimeout(r, 300));
  assert.deepStrictEqual(await ack(s, 'roomInfo', 'room-gt'), { empty: true }, 'forgotten after its own grace time');
});

test('a room named like a socket id is not that socket\'s room', async () => {
  const a = await client('SI1'), b = await client('SI2'), spy = await client('SI3');
  await join(a, 'room-si'); await join(b, 'room-si');
  assert.deepStrictEqual(await ack(await client('SI4'), 'roomInfo', b.c.id), { empty: true });
  const noJoin = quiet(b.c, 'userJoined');
  await join(spy, b.c.id); // socket.io puts each socket in a room of its id
  await noJoin;
  const leak = quiet(spy.c, 'signaling'), got = nextEvent(b.c, 'signaling');
  a.c.emit('signaling', { destUUID: 'SI2', signalingData: 'hi' });
  assert.strictEqual((await got).signalingData, 'hi');
  await leak;
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('a dropped UUID stays its owner\'s for the grace time, counted from its last drop', async () => {
  const a = await client('DR1', 'mine'), b = await client('DR2');
  await join(a, 'room-dr'); await join(b, 'room-dr');
  const left = nextEvent(b.c, 'userDiscconected');
  a.c.close();
  assert.strictEqual(await left, 'DR1');
  assert.ok((await client('DR1', 'thief')).err, 'a room member cannot take it over');
  await sleep(200);
  const back = await client('DR1', 'mine'); // the owner reconnects ...
  await join(back, 'room-dr');
  const leftAgain = nextEvent(b.c, 'userDiscconected');
  back.c.close(); // ... and drops again
  await leftAgain;
  await sleep(150); // past the first drop's grace time (ROOM_GRACE_MS is 300 here), inside the second's
  assert.ok((await client('DR1', 'thief')).err, 'the first drop\'s timer does not free it');
  for (let i = 0; (await client('DR1', 'new')).err; i++) { assert.ok(i < 20, 'freed after the grace time'); await sleep(100); }
});

test('server pings every 10s and drops a silent socket after 10s more', async () => {
  const { c } = await client('PG1');
  assert.ok(c.io.engine.pingInterval + c.io.engine.pingTimeout <= 20000);
});

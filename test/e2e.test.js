// End-to-end: real server + headless Chromium with fake cam/mic.
// Run: npm test (SLOW=1 adds the 45s outage test)
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright-core');

const BASE = require('./boot')({ ICESERVERS_FILE: require('path').join(__dirname, '../iceservers.example.json') }) + '/'; // public STUN only, whatever the local iceservers.json says
let browser;

before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream=device-count=2', // two cameras -> picker shown
      '--disable-features=WebRtcHideLocalIpsWithMdns', // plain host candidates, no mDNS
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
});

after(async () => {
  await browser?.close();
});

// Per test: its own room, and the browser contexts it opened. They are closed after the test, and an uncaught page error fails it.
const tests = new WeakMap();
function state(t) {
  if (!tests.has(t)) {
    const s = { room: 'r' + Date.now(), contexts: [], errors: [] };
    tests.set(t, s);
    t.after(async () => {
      await Promise.all(s.contexts.map(c => c.close()));
      assert.deepStrictEqual(s.errors, [], 'page errors');
    });
  }
  return tests.get(t);
}
const room = t => state(t).room;

async function context(t, opts) {
  const ctx = await browser.newContext(opts), s = state(t);
  ctx.on('weberror', e => s.errors.push(e.error().message));
  s.contexts.push(ctx);
  return ctx;
}

// Page in the test's room, in the lobby, not joined yet. name: as if typed in the lobby before (never in the URL), null for none.
async function open(t, name, init, path = '', opts) {
  const page = await (await context(t, opts)).newPage();
  if (name) await page.addInitScript(n => sessionStorage.username ||= n, name);
  if (init) await page.addInitScript(init);
  await page.goto(`${BASE}${path}#roomname=${room(t)}`);
  return page;
}

async function join(...args) {
  const page = await open(...args);
  await page.click('#joinBtn'); // lobby: sound and camera check first
  return page;
}

// Alice and Bob in a call: one peer each, ICE up, audio live.
async function call(t, initA, initB) {
  const a = await join(t, 'alice', initA), b = await join(t, 'bob', initB);
  await waitFor(async () => (await callUp(a)) && (await callUp(b)), 'call up');
  return [a, b];
}

async function waitFor(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    if ((last = await fn())) return last;
    await new Promise(r => setTimeout(r, 250));
  }
  assert.fail(`timed out waiting for ${what} (last=${last})`);
}

// Number of remote peers whose ICE is connected, as seen from `page`.
const connectedPeers = page => page.evaluate(() =>
  Object.values(pcs).filter(p => p.isConnected).length);

// Number of remote <audio> elements actually receiving a live track.
const liveRemoteAudio = page => page.evaluate(() =>
  [...document.querySelectorAll('#audioStreams audio')]
    .filter(a => a.srcObject && a.srcObject.getAudioTracks().some(t => t.readyState === 'live' && !t.muted)).length);

// Each side has exactly one peer, its ICE is up now, and its audio is live.
const callUp = async p => (await p.evaluate(() => Object.values(pcs).length == 1 && Object.values(pcs)[0].iceUp())) && (await liveRemoteAudio(p)) === 1;

// Status text on a remote peer's tile ("" when connected).
const peerStatus = page => page.evaluate(() =>
  [...document.querySelectorAll('#mediaDiv .peerStatus')].filter(e => e.parentElement != allUserStreams[MY_UUID].tile).map(e => e.textContent).join('|'));
const selfStatus = page => page.evaluate(() => allUserStreams[MY_UUID]?.tile?.querySelector('.peerStatus')?.textContent);

const remoteVideoShown = page => page.evaluate(() => [...document.querySelectorAll('#mediaDiv video')]
  .some(v => v.srcObject && v.videoWidth > 0 && !v.classList.contains('mirror')));

// Init script: keeps the raw RTCPeerConnections in window.__raw.
const trackPcs = () => { const O = RTCPeerConnection; window.__raw = []; window.RTCPeerConnection = function (c) { const p = new O(c); __raw.push(p); return p; }; };
const iceUp = p => p.evaluate(() => __raw.some(x => ['connected', 'completed'].includes(x.iceConnectionState)));

// Replaces the first peer's signaling handler with wrap(d, orig). wrap runs in the page: page globals only, no closures.
const onSignaling = (page, wrap) => page.evaluate(`(pc => { const orig = pc.signaling, wrap = ${wrap}; pc.signaling = d => wrap(d, orig); })(Object.values(pcs)[0])`);

// A socket's events are handled in order: once this answer is back, all the page sent before, and the server sent it before, is handled.
const serverSync = page => page.evaluate(() => new Promise(r => socket.emit('roomInfo', roomname, r)));

async function chat(page, text) {
  if (await page.locator('#chatDiv').isHidden()) { await page.click('#moreBtn'); await page.click('#addRemoveChatBtn'); }
  await page.fill('#chatInputText', text);
  await page.press('#chatInputText', 'Enter');
}

test('peers connect when the page is opened as index.html', async t => {
  await join(t, 'alice', null, 'index.html');
  const b = await join(t, 'bob', null, 'index.html');
  await waitFor(async () => (await connectedPeers(b)) === 1, 'ICE connected');
});

test('two peers connect and exchange audio', t => call(t));

test('own tile shows "connecting…" until joined and "reconnecting…" while the server is gone', async t => {
  const ctx = await context(t);
  await ctx.route('**/socket.io/**', r => r.abort()); // server unreachable
  const a = await ctx.newPage();
  await a.goto(`${BASE}#roomname=${room(t)}`);
  assert.strictEqual(await selfStatus(a), '', 'nothing while in the lobby');
  await a.click('#joinBtn');
  await waitFor(async () => (await selfStatus(a)) === 'connecting…', 'connecting shown');
  await ctx.unroute('**/socket.io/**');
  await waitFor(async () => (await selfStatus(a)) === '', 'status cleared after join');
  await a.evaluate(() => socket.disconnect());
  await waitFor(async () => (await selfStatus(a)) === 'reconnecting…', 'reconnecting shown');
  await a.evaluate(() => socket.connect());
  await waitFor(async () => (await selfStatus(a)) === '', 'status cleared after rejoin');
});

test('peer tile shows "connecting" until ICE is up, then nothing', async t => {
  const holdIce = () => { // the peer's ICE candidates wait for __go(): no ICE before
    const add = RTCPeerConnection.prototype.addIceCandidate, go = new Promise(r => window.__go = r);
    RTCPeerConnection.prototype.addIceCandidate = function (c) { window.__held = true; return go.then(() => add.call(this, c)); };
  };
  const a = await join(t, 'alice', holdIce), b = await join(t, 'bob', holdIce);
  for (const p of [a, b]) await waitFor(() => p.evaluate(() => window.__held), 'candidates arrived'); // all but ICE is done
  assert.strictEqual(await peerStatus(a) + await peerStatus(b), 'connecting…connecting…');
  for (const p of [a, b]) await p.evaluate(() => __go());
  await waitFor(async () => (await connectedPeers(a)) === 1 && (await connectedPeers(b)) === 1, 'ICE connected');
  await waitFor(async () => (await peerStatus(a)) === '' && (await peerStatus(b)) === '', 'status cleared');
});

test('camera toggle reaches the other peer', async t => {
  const [a, b] = await call(t);
  await a.click('#addRemoveCameraBtn');
  await waitFor(() => remoteVideoShown(b), 'remote video on bob');
});

// #3: bob turns on his camera after answering alice's offer, but before alice has applied that
// answer: his video must still reach alice. Since #57 a camera change sends no offer, so an ICE restart makes one.
test('answerer camera change during an in-flight offer reaches the initiator', async t => {
  const a = await join(t, 'alice', trackPcs); // already in the room -> initiator
  const b = await join(t, 'bob');
  await waitFor(async () => (await connectedPeers(b)) === 1, 'ICE connected');
  await onSignaling(a, (d, orig) => d?.type == 'answer' ? new Promise(r => setTimeout(r, 3000)).then(() => orig(d)) : orig(d)); // hold back bob's answers on alice for 3s
  await onSignaling(b, (d, orig) => orig(d).then(() => { if (d?.type == 'offer') window.__answered = true; })); // bob answered an offer
  await a.click('#addRemoveCameraBtn');
  await a.evaluate(() => __raw.at(-1).restartIce()); // an offer in flight
  await waitFor(() => b.evaluate(() => window.__answered), 'bob answered alice\'s offer', 3000);
  await b.click('#addRemoveCameraBtn'); // after bob answered, before alice applied the answer
  await waitFor(() => remoteVideoShown(b), 'remote video on bob');
  await waitFor(() => remoteVideoShown(a), 'remote video on alice');
});

// #25: one lost answer must not block all later renegotiation.
const offerSent = page => waitFor(() => page.evaluate(() => Object.values(pcs)[0].makingOffer), 'offer sent');
const offerAnswered = (page, ms) => waitFor(() => page.evaluate(() => !Object.values(pcs)[0].makingOffer && __raw.at(-1).signalingState == 'stable'), 'offer answered', ms);

test('a lost answer does not block later negotiation', async t => {
  const a = await join(t, 'alice', trackPcs);
  const b = await join(t, 'bob');
  await waitFor(async () => (await connectedPeers(b)) === 1, 'ICE connected');
  await onSignaling(a, (d, orig) => d?.type == 'answer' && !window.__dropped ? (window.__dropped = true, Promise.resolve()) : orig(d)); // drop exactly one answer on alice
  await a.evaluate(() => __raw.at(-1).restartIce()); // since #57 camera changes send no offer: an ICE restart does
  await offerSent(a);
  await offerAnswered(a); // offered again after the lost answer
  await a.evaluate(() => __raw.at(-1).restartIce());
  await offerSent(a);
  await offerAnswered(a, 4000); // the next one goes through at once
  await a.click('#addRemoveCameraBtn');
  await b.click('#addRemoveCameraBtn');
  await waitFor(() => remoteVideoShown(b), 'remote video on bob');
  await waitFor(() => remoteVideoShown(a), 'remote video on alice');
});

// Mid-deploy: an older answerer doesn't echo gen; its answers must still be applied.
test('answers without gen (older client) are still accepted', async t => {
  const a = await join(t, 'alice', trackPcs);
  const b = await join(t, 'bob');
  await waitFor(async () => (await connectedPeers(b)) === 1, 'ICE connected');
  await onSignaling(a, (d, orig) => orig(d?.type == 'answer' ? { type: d.type, sdp: d.sdp } : d)); // strip gen from every answer alice receives
  await a.evaluate(() => __raw.at(-1).restartIce()); // since #57 camera changes send no offer: an ICE restart does
  await offerSent(a);
  await offerAnswered(a, 4000); // applied, not re-offered after 5s
});

// #59: a delayed offer and the re-offer behind it reach bob in the same tick; he must answer each in turn.
test('back-to-back offers each get their own answer', async t => {
  const a = await join(t, 'alice', trackPcs);
  const b = await join(t, 'bob');
  await waitFor(async () => (await connectedPeers(b)) === 1, 'ICE connected');
  const errors = [];
  b.on('console', m => m.text().includes('signaling error') && errors.push(m.text()));
  await b.evaluate(() => { // hold alice's offers on bob until her 5s timeout re-offers, then hand both over at once; record bob's answers
    const h = socket.listeners('signaling')[0];
    let held = [];
    socket.off('signaling', h);
    socket.on('signaling', d => {
      if (!held || d.signalingData?.type != 'offer') return h(d);
      if (held.push(d) < 2) return;
      window.__offerGens = held.map(d => d.signalingData.gen);
      held.forEach(h); held = null;
    });
    const emit = socket.emit;
    window.__answerGens = [];
    socket.emit = function (ev, d) { if (d?.signalingData?.type == 'answer') __answerGens.push(d.signalingData.gen); return emit.apply(this, arguments); };
  });
  await a.evaluate(() => __raw.at(-1).restartIce()); // since #57 camera changes send no offer: an ICE restart does
  await waitFor(() => b.evaluate(() => __answerGens.length >= 2), 'two answers', 15000);
  assert.deepStrictEqual(await b.evaluate(() => __answerGens.slice(0, 2)), await b.evaluate(() => __offerGens), 'one answer per offer, same gen'); // later offers may follow
  assert.deepStrictEqual(errors, []);
  await a.click('#addRemoveCameraBtn'); // media still flows after both answers
  await waitFor(() => remoteVideoShown(b), 'remote video on bob');
});

// #88 holds the initiator's candidates only on renegotiation: on the first offer the answerer gets them at once,
// so behind a NAT or firewall it opens its pinhole towards the initiator before its answer is even back.
test('first connect: the answerer checks the initiator\'s candidates before its answer arrives', async t => {
  const a = await join(t, 'alice', trackPcs); // already in the room -> initiator
  await a.evaluate(() => { // alice gets no answer until __release()
    const h = socket.listeners('signaling')[0];
    let held = [];
    socket.off('signaling');
    socket.on('signaling', d => d.signalingData?.type == 'answer' && held ? held.push(d) : h(d));
    window.__release = () => { held.splice(0).forEach(h); held = null; };
  });
  const b = await join(t, 'bob');
  await waitFor(async () => (await connectedPeers(b)) === 1, 'bob ICE up');
  assert.strictEqual(await a.evaluate(() => __raw.at(-1).signalingState), 'have-local-offer', 'alice has no answer yet');
  await a.evaluate(() => __release());
  for (const p of [a, b]) await waitFor(async () => (await connectedPeers(p)) === 1 && (await liveRemoteAudio(p)) === 1, 'ICE and audio');
});

// #6: bob's socket reconnects; alice's old pc still sends an offer to bob before alice rebuilds it.
test('stale offer from the old connection after a fast reconnect', async t => {
  const [a, b] = await call(t);
  await a.evaluate(() => {
    window.__oldPc = Object.values(pcs)[0];
    socket.off('userJoined');
    socket.on('userJoined', c => { __oldPc.signaling('renegotiate'); setTimeout(() => createRemoteSocket(true, c.UUID), 1500); });
  });
  await b.evaluate(() => socket.io.engine.close());
  await waitFor(() => a.evaluate(() => Object.values(pcs)[0] !== __oldPc), 'alice rebuilt the pc');
  for (const p of [a, b]) await waitFor(() => callUp(p), 'ICE and audio');
});

test('camera picker switches the camera sent to the other peer', async t => {
  const [a, b] = await call(t);
  await a.click('#addRemoveCameraBtn');
  await waitFor(() => remoteVideoShown(b), 'remote video on bob');
  await waitFor(() => a.locator('#selectCameraBtn').isVisible(), 'picker visible');
  const camId = () => a.evaluate(() => allUserStreams[MY_UUID].videostream.getVideoTracks()[0].getSettings().deviceId);
  const other = await a.evaluate(cur => [...document.querySelectorAll('#cameraSelect option')].find(o => o.value != cur).value, await camId());
  await a.selectOption('#cameraSelect', other);
  await waitFor(async () => (await camId()) === other, 'camera switched');
  await waitFor(() => remoteVideoShown(b), 'remote video after switch');
});

test('screen share reaches the other peer', async t => {
  const [a, b] = await call(t);
  await a.click('#addRemoveScreenBtn');
  await waitFor(() => a.evaluate(() => screenActive), 'screen capture started');
  await waitFor(() => remoteVideoShown(b), 'remote screen on bob');
});

// #13: Detail (default) / Performance mode for screen share, applied live without renegotiation.
const screenMode = page => page.evaluate(() => {
  const track = allUserStreams[MY_UUID].videostream.getVideoTracks()[0];
  const senders = __raw.flatMap(p => p.getSenders().filter(s => s.track === track));
  return [track.contentHint, ...senders.map(s => s.getParameters().degradationPreference)];
});

test('screen share mode: detail by default, performance via dropdown, applied to late joiners', async t => {
  const [a, b] = await call(t, trackPcs);
  assert.strictEqual(await a.locator('#selectScreenModeBtn').isVisible(), false, 'hidden without screen share');
  await a.click('#addRemoveCameraBtn');
  await waitFor(() => remoteVideoShown(b), 'remote video on bob');
  assert.strictEqual(await a.locator('#selectScreenModeBtn').isVisible(), false, 'hidden for camera');
  await a.click('#addRemoveScreenBtn');
  await waitFor(() => a.evaluate(() => screenActive), 'screen capture started');
  await waitFor(() => remoteVideoShown(b), 'remote screen on bob');
  assert.ok(await a.locator('#selectScreenModeBtn').isVisible(), 'dropdown shown while sharing');
  await waitFor(async () => (await screenMode(a)).join() === 'detail,maintain-resolution', 'detail mode');
  await onSignaling(b, (d, orig) => { if (d?.type == 'offer') window.__offered = true; return orig(d); });
  await a.selectOption('#screenModeSelect', 'motion');
  await waitFor(async () => (await screenMode(a)).join() === 'motion,maintain-framerate', 'performance mode');
  await a.selectOption('#screenModeSelect', 'detail');
  await waitFor(async () => (await screenMode(a)).join() === 'detail,maintain-resolution', 'back to detail');
  await a.selectOption('#screenModeSelect', 'motion');
  await waitFor(async () => (await screenMode(a)).join() === 'motion,maintain-framerate', 'performance mode again');
  const frames = () => b.evaluate(() => [...document.querySelectorAll('#mediaDiv video')].map(v => v.getVideoPlaybackQuality().totalVideoFrames).reduce((x, y) => x + y, 0));
  const before = await frames();
  await waitFor(async () => (await frames()) > before, 'remote video keeps playing');
  assert.strictEqual(await b.evaluate(() => window.__offered), undefined, 'no renegotiation');
  const c = await join(t, 'carol');
  await waitFor(() => remoteVideoShown(c), 'remote screen on carol');
  await waitFor(async () => (await screenMode(a)).join() === 'motion,maintain-framerate,maintain-framerate', 'late joiner gets mode');
  await a.click('#addRemoveScreenBtn');
  await waitFor(async () => !(await a.locator('#selectScreenModeBtn').isVisible()), 'hidden after share ends');
  await a.click('#addRemoveCameraBtn');
  await waitFor(() => a.evaluate(() => camActive), 'camera on');
  await a.evaluate(() => { const s = document.getElementById('screenModeSelect'); s.value = 'detail'; s.dispatchEvent(new Event('change')); }); // e.g. a popup left open
  assert.strictEqual(await a.evaluate(() => allUserStreams[MY_UUID].videostream.getVideoTracks()[0].contentHint), '', 'camera track untouched');
  assert.deepStrictEqual((await screenMode(a)).slice(1), [undefined, undefined], 'the camera does not inherit the share\'s preference (#57: one sender)');
});

test('browser "Stop sharing" ends the screen share', async t => {
  const [a, b] = await call(t);
  await a.click('#addRemoveScreenBtn');
  await waitFor(() => remoteVideoShown(b), 'remote screen on bob');
  // Chrome's "Stop sharing" bar ends the track; stop() alone doesn't fire 'ended'.
  await a.evaluate(() => allUserStreams[MY_UUID].videostream.getVideoTracks()[0].dispatchEvent(new Event('ended')));
  await waitFor(async () => !(await a.evaluate(() => screenActive)), 'screen share stopped');
  await waitFor(async () => !(await remoteVideoShown(b)), 'remote screen gone on bob');
});

// Video path per peer: ICE, tile has video, slot track muted; video elements; raw pcs' transceivers (if tracked).
const videoState = page => page.evaluate(() => JSON.stringify({
  pcs: Object.entries(pcs).map(([id, pc]) => [id.slice(0, 4), pc.iceUp(), !!allUserStreams[id]?.videostream, pc.remoteVideo?.getVideoTracks()[0].muted]),
  videos: [...document.querySelectorAll('#mediaDiv video')].map(v => [v.videoWidth, v.readyState]),
  raw: window.__raw?.map(r => [r.connectionState, r.getTransceivers().map(t => [t.mid, t.currentDirection, t.sender.track?.readyState])]),
}));

test('camera turned on before the peer connects', async t => {
  const a = await join(t, 'alice');
  await waitFor(() => a.evaluate(() => !!allUserStreams[MY_UUID]), 'mic ready');
  // Start the camera right after the pc is created, before ICE connects.
  await a.evaluate(async () => {
    const cam = await navigator.mediaDevices.getUserMedia({ video: true });
    socket.once('userJoined', () => { camActive = true; startVideo(cam, $('#addRemoveCameraBtn')); });
  });
  const b = await join(t, 'bob', trackPcs);
  await waitFor(() => remoteVideoShown(b), 'remote video on bob');
  // Non-initiator side: bob's camera is already on when his pc is (re)created.
  await b.click('#addRemoveCameraBtn');
  await waitFor(() => remoteVideoShown(a), 'remote video on alice');
  await a.evaluate(() => window.__oldPc = Object.values(pcs)[0]);
  await b.evaluate(() => { __raw[0].close(); socket.io.engine.close(); }); // bob's connection dies, his socket reconnects
  await waitFor(() => a.evaluate(() => Object.values(pcs)[0] && Object.values(pcs)[0] !== __oldPc), 'alice rebuilt the pc');
  await waitFor(() => remoteVideoShown(a), 'remote video on alice after reconnect').catch(async e => { // failed once in CI only: show where it stopped
    console.log('alice', await videoState(a), 'bob', await videoState(b));
    throw e;
  });
});

test('third peer joins a running call', async t => {
  const pages = await call(t);
  pages.push(await join(t, 'carol'));
  for (const p of pages) await waitFor(async () => (await connectedPeers(p)) === 2, 'full mesh');
});

test('peer leaves: the other side cleans up', async t => {
  const [a, b] = await call(t);
  await b.context().close();
  await waitFor(async () => (await a.locator('#audioStreams audio').count()) === 0, 'audio element removed');
});

test('signaling socket reconnect keeps the call working', async t => {
  const [a, b] = await call(t);
  await waitFor(() => b.evaluate(() => Object.values(pcs)[0].send({})), 'data channel open');
  for (const p of [a, b]) await p.evaluate(() => window.__pc = Object.values(pcs)[0]);
  // Simulate a network blip / proxy idle timeout on alice's signaling socket.
  assert.strictEqual(await a.evaluate(() => { socket.io.engine.close(); return allUserStreams[MY_UUID].tile.querySelector('.peerStatus').textContent; }), 'reconnecting…');
  await waitFor(async () => (await selfStatus(a)) === '', 'rejoined');
  assert.strictEqual(await a.evaluate(() => socket.listeners('signaling').length), 1, 'signaling handler registered once');
  // A chat line sent once must arrive once: a duplicate would come before the next line.
  await chat(b, 'ping');
  await chat(b, 'pong');
  await waitFor(() => a.locator('#chatText div', { hasText: 'pong' }).count(), 'chat on alice');
  assert.strictEqual(await a.locator('#chatText div', { hasText: 'ping' }).count(), 1, 'chat delivered once');
  // After the blip alice must still be able to renegotiate (turn on cam) and chat.
  await a.click('#addRemoveCameraBtn');
  await waitFor(() => remoteVideoShown(b), 'remote video after reconnect');
  for (const p of [a, b]) {
    await waitFor(() => callUp(p), 'one live peer each');
    assert.ok(await p.evaluate(() => Object.values(pcs)[0] === __pc), 'working pc not replaced');
  }
});

test('a peer\'s {video: true} shows its video slot even before the connection is up (#57)', async t => {
  const a = await join(t, 'alice');
  await waitFor(async () => (await selfStatus(a)) === '', 'joined'); // the join's member list would drop the ghost
  await a.evaluate(() => { socket.listeners('userJoined')[0]({ UUID: 'ghost', keep: [] }); pcs.ghost.emitEvent('message', { video: true }); }); // no answer yet
  assert.ok(await a.evaluate(() => allUserStreams.ghost.videostream?.getVideoTracks().length === 1), 'tile has the slot\'s track');
});

// #57: one video transceiver per peer; camera on/off swaps its track, no renegotiation.
test('camera toggles reuse one video slot, without renegotiation (#57)', async t => {
  const [a, b] = await call(t, trackPcs, trackPcs);
  await waitFor(() => b.evaluate(() => Object.values(pcs)[0].send({})), 'data channel open');
  for (const p of [a, b]) await p.evaluate(() => { // count descriptions applied from now on
    const pc = __raw.at(-1), set = pc.setRemoteDescription.bind(pc);
    window.__sets = 0;
    pc.setRemoteDescription = d => (__sets++, set(d));
  });
  for (let i = 0; i < 3; i++) {
    for (const [p, q] of [[a, b], [b, a]]) {
      await p.click('#addRemoveCameraBtn');
      await waitFor(() => remoteVideoShown(q), 'remote video on');
      await p.click('#addRemoveCameraBtn');
      await waitFor(async () => !(await remoteVideoShown(q)), 'remote video off');
    }
  }
  for (const p of [a, b]) {
    assert.strictEqual(await p.evaluate(() => __sets), 0, 'no offer/answer per toggle');
    assert.strictEqual(await p.evaluate(() => __raw.at(-1).getTransceivers().length), 2, 'audio + one video slot');
  }
});

test('chat shows messages as text and keeps links clickable', async t => {
  const [a, b] = await call(t);
  const msg = `<img src=x onerror="window.__xss=1"> it's "ok" https://example.com/a?b=1`;
  await chat(a, msg);
  await waitFor(() => b.evaluate(() => document.querySelector('#chatText').textContent.includes('example.com')), 'message on bob');
  assert.strictEqual(await b.evaluate(() => document.querySelector('#chatText div:last-child').textContent), 'alice: ' + msg, 'text, no <img> made of it');
  assert.strictEqual(await b.evaluate(() => document.querySelector('#chatText div:last-child .chatName').textContent), 'alice', 'sender name styled apart');
  assert.strictEqual(await b.evaluate(() => document.querySelector('#chatText a').href), 'https://example.com/a?b=1');
  assert.strictEqual(await a.inputValue('#chatInputText'), '', 'input cleared');
});

test('quote-free chat payload does not execute (bypasses old server escaping)', async t => {
  const [a, b] = await call(t);
  // No ' " \\ $ chars, so the upstream server's escaping leaves it intact.
  const payload = '<img src=x onerror=window.__xss=1>';
  await chat(a, payload);
  await waitFor(() => b.evaluate(() => document.querySelectorAll('#chatText > div').length > 0), 'message on bob');
  for (const p of [b, a]) assert.strictEqual(await p.evaluate(() => document.querySelector('#chatText div:last-child').textContent), 'alice: ' + payload, 'text, no <img> made of it');
});

test('remote username is shown as text', async t => {
  const a = await join(t, '<img src=x onerror=window.__xss=1>');
  const b = await join(t, 'bob');
  await waitFor(async () => (await connectedPeers(b)) === 1, 'ICE connected');
  await a.click('#addRemoveCameraBtn');
  await waitFor(() => remoteVideoShown(b), 'remote video on bob');
  await waitFor(() => b.evaluate(() => document.querySelector('#mediaDiv').textContent.includes('<img src=x')), 'name shown literally');
  assert.strictEqual(await b.locator('#mediaDiv img[src=x]').count(), 0, 'no <img> made of it');
});

test('chat, mute state and username reach the peer without the server (#11)', async t => {
  const [a, b] = await call(t);
  await a.evaluate(() => { socket.emit = () => { }; }); // alice can no longer reach the server
  await chat(a, 'hi via p2p');
  await waitFor(() => b.evaluate(() => document.querySelector('#chatText').textContent == 'alice: hi via p2p'), 'chat on bob');
  assert.strictEqual(await a.evaluate(() => document.querySelector('#chatText').textContent), 'alice: hi via p2p', 'shown locally');
  await a.click('#muteUnmuteMicBtn');
  await waitFor(() => b.locator('.audioMuted').count(), 'mute icon on bob');
  await waitFor(() => b.evaluate(() => document.querySelector('#mediaDiv').textContent.includes('AL')), 'alice\'s initials on bob');
  await b.evaluate(() => { const pc = Object.values(pcs)[0]; pc.send(null); pc.send(5); pc.send({ username: 'x'.repeat(500), chat: 'long' + 'y'.repeat(5000) }); }); // a peer can send anything
  await waitFor(() => a.evaluate(() => document.querySelector('#chatText').textContent.includes('long')), 'chat on alice');
  assert.ok(await a.evaluate(() => Object.values(allUserStreams).every(u => u.username.length <= 64)), 'username capped');
  assert.ok(await a.evaluate(() => document.querySelector('#chatText div:last-child').textContent.length <= 2100), 'chat capped');
});

test('camera changes renegotiate without the server (#11)', async t => {
  const [a, b] = await call(t);
  await waitFor(() => b.evaluate(() => Object.values(pcs)[0].send({})), 'data channel open');
  for (const p of [a, b]) await p.evaluate(() => socket.disconnect());
  await a.click('#addRemoveCameraBtn'); // initiator: offer over the data channel
  await waitFor(() => remoteVideoShown(b), 'remote video on bob');
  await b.click('#addRemoveCameraBtn'); // answerer: {video: true} over the data channel
  await waitFor(() => remoteVideoShown(a), 'remote video on alice');
});

test('call survives the signaling server going away and coming back (#11)', async t => {
  const [a, b] = await call(t);
  await waitFor(() => b.evaluate(() => Object.values(pcs)[0].send({})), 'data channel open');
  for (const p of [a, b]) await p.evaluate(() => window.__pc = Object.values(pcs)[0]);
  await b.evaluate(() => socket.on('userJoined', () => window.__rejoined = true)); // runs after the app's handler
  await a.evaluate(() => socket.disconnect()); // server tells bob "userDiscconected"
  await waitFor(() => b.evaluate(() => __pc.left), 'bob saw alice leave the server');
  for (const p of [a, b]) {
    assert.strictEqual(await liveRemoteAudio(p), 1, 'audio still live');
    assert.strictEqual(await p.locator('#mediaDiv .videoplaceholder').count(), 2, 'no tile removed');
  }
  await chat(a, 'still here');
  await waitFor(() => b.evaluate(() => document.querySelector('#chatText').textContent.includes('still here')), 'chat while server is gone');
  await a.evaluate(() => socket.connect()); // rejoin: bob gets "userJoined" for alice's UUID
  await waitFor(() => b.evaluate(() => window.__rejoined), 'bob handled alice\'s rejoin');
  for (const p of [a, b]) {
    assert.ok(await p.evaluate(() => Object.keys(pcs).length == 1 && Object.values(pcs)[0] === __pc), 'same peer connection kept');
    assert.strictEqual(await liveRemoteAudio(p), 1, 'audio live after rejoin');
  }
});

test('network switch: ICE and socket lost together, the call comes back', async t => {
  const [a, b] = await call(t, trackPcs);
  for (const p of [a, b]) await p.evaluate(() => Object.values(pcs)[0].mappedEvents.close = []); // a lost network sends no goodbye
  await a.evaluate(() => { __raw[0].close(); socket.io.engine.close(); }); // old network gone: no ICE, socket drops and reconnects
  for (const p of [a, b]) await waitFor(() => callUp(p), 'call up again', 30000);
});

test('ICE down: fresh ICE servers are fetched and set on the connection for its restart (#28)', async t => {
  const spy = () => { const s = RTCPeerConnection.prototype.setConfiguration; window.__configs = []; RTCPeerConnection.prototype.setConfiguration = function (c) { __configs.push(c); return s.call(this, c); }; };
  const [a] = await call(t, spy);
  assert.strictEqual(await a.evaluate(() => __configs.length), 0);
  await a.evaluate(() => { window.__old = webRTCConfig.iceServers; Object.values(pcs)[0].emitEvent('icestate', 'disconnected'); }); // as when the path drops
  await waitFor(() => a.evaluate(() => __configs.length), 'ICE servers set');
  assert.ok(await a.evaluate(() => __configs[0].iceServers === webRTCConfig.iceServers && __configs[0].iceServers !== __old), 'the ones just sent by the server, not the cached ones');
});

test('rejoining peer that still has the call gets a reset when the other side rebuilds', async t => {
  const [a, b] = await call(t);
  for (const p of [a, b]) await p.evaluate(() => window.__pc = Object.values(pcs)[0]);
  await b.evaluate(() => __pc.iceUp = () => false); // bob's side of the call is dead, alice's looks fine
  await a.evaluate(() => __pc.mappedEvents.close = []); // no close event reaches alice either
  await a.evaluate(() => socket.io.engine.close()); // alice rejoins, keeping bob
  for (const p of [a, b]) await waitFor(async () => (await p.evaluate(() => Object.values(pcs)[0] !== __pc)) && (await callUp(p)), 'new call on both sides');
});

// Bob's rebuild closes the old connection; that close reaches alice over P2P before his reset comes via the server.
test('a rebuild by the other side does not make the rejoining peer rebuild too', async t => {
  const [a, b] = await call(t);
  for (const p of [a, b]) await p.evaluate(() => window.__pc = Object.values(pcs)[0]);
  await a.evaluate(() => socket.disconnect());
  await waitFor(() => b.evaluate(() => __pc.left), 'bob saw alice leave');
  await b.evaluate(() => __pc.iceUp = () => false); // bob's side of the call is dead, alice's looks fine
  await b.evaluate(() => { const e = socket.emit.bind(socket); socket.emit = (n, ...a) => n == 'signaling' ? setTimeout(() => e(n, ...a), 150) : e(n, ...a); }); // server 150ms farther than alice
  await a.evaluate(() => socket.connect()); // alice rejoins, keeping bob
  for (const p of [a, b]) await waitFor(async () => (await p.evaluate(() => Object.values(pcs)[0] !== __pc)) && (await callUp(p)), 'new call on both sides', 20000);
});

// #58: a long outage makes SCTP give up and close the data channel while both sockets stay up.
test('data channel closed while both peers stay on the server: the call is rebuilt', async t => {
  const trackDcs = () => { const c = RTCPeerConnection.prototype.createDataChannel; window.__dcs = []; RTCPeerConnection.prototype.createDataChannel = function (...a) { const d = c.apply(this, a); __dcs.push(d); return d; }; };
  const [a, b] = await call(t, null, trackDcs);
  await waitFor(() => b.evaluate(() => Object.values(pcs)[0].send({})), 'data channel open');
  for (const p of [a, b]) await p.evaluate(() => { window.__pc = Object.values(pcs)[0]; __pc.iceUp = () => false; }); // the outage has ICE down too
  await b.evaluate(() => __dcs[0].close()); // "close" on both sides
  for (const p of [a, b]) {
    await waitFor(async () => (await p.evaluate(() => { const pc = Object.values(pcs)[0]; return pc !== __pc && pc?.send({}); })) && (await callUp(p)), 'new call with an open data channel', 30000);
    assert.strictEqual(await p.locator('#mediaDiv .videoplaceholder').count(), 2, 'peer tile back');
  }
});

test('signaling uses the socket while it is up, even if the data channel reads open', async t => {
  const [a, b] = await call(t);
  await waitFor(() => b.evaluate(() => Object.values(pcs)[0].send({})), 'data channel open');
  await b.evaluate(() => { const pc = Object.values(pcs)[0], send = pc.send; pc.send = m => m.signaling ? true : send(m); }); // one-way outage: bob's sends get lost
  await a.click('#addRemoveCameraBtn');
  await b.click('#addRemoveCameraBtn');
  await waitFor(async () => (await remoteVideoShown(a)) && (await remoteVideoShown(b)), 'video both ways');
});

// Both sockets blip: bob sees alice leave, then is offline himself while she rejoins. His view must resync on rejoin.
test('stale "left the server" mark is cleared when rejoining a room the peer is in', async t => {
  const [a, b] = await call(t);
  await a.evaluate(() => socket.disconnect());
  await waitFor(() => b.evaluate(() => Object.values(pcs)[0].left), 'bob saw alice leave');
  await b.evaluate(() => socket.disconnect());
  await a.evaluate(() => socket.connect());
  await waitFor(async () => (await selfStatus(a)) === '', 'alice rejoined');
  await b.evaluate(() => socket.connect());
  await waitFor(async () => (await selfStatus(b)) === '', 'bob rejoined');
  // short ICE blip on bob's side
  await b.evaluate(() => { const pc = Object.values(pcs)[0], up = pc.iceUp; pc.iceUp = () => false; pc.emitEvent('icestate', 'disconnected'); pc.iceUp = up; });
  assert.ok(await callUp(b), 'call kept through the blip');
});

test('peer that crashed while we were off the server is removed after we rejoin', async t => {
  const [a, b] = await call(t);
  await a.evaluate(() => socket.disconnect());
  (await b.context().newCDPSession(b)).send('Page.crash').catch(() => { }); // never resolves: the renderer is gone
  await a.evaluate(() => socket.connect());
  await waitFor(async () => (await a.locator('#mediaDiv .videoplaceholder').count()) === 1, 'tile removed', 30000);
});

// #62: offline past the grace time and someone else registered our UUID: join as a new user, not "reconnecting…" forever.
test('a page whose UUID was taken while it was offline joins again under a new one', async t => {
  const [a, b] = await call(t);
  const old = await a.evaluate(() => { // the server refuses the next registration, as for a UUID someone else took
    socket.disconnect();
    const emit = socket.emit;
    socket.emit = (e, d, ack) => e == 'registerUUID' ? (delete socket.emit, emit.call(socket, e, { ...d, UUID_KEY: 'stale' }, ack)) : emit.call(socket, e, d, ack);
    return MY_UUID;
  });
  await a.evaluate(() => socket.connect());
  await waitFor(async () => (await selfStatus(a)) === '', 'alice joined again');
  for (const p of [a, b]) await waitFor(() => callUp(p), 'call up again'); // bob: alice is a new user, her old pc is gone
  const now = await a.evaluate(() => MY_UUID);
  assert.notStrictEqual(now, old);
  assert.deepStrictEqual(await b.evaluate(() => Object.keys(pcs)), [now]); // no ghost of the old UUID
});

test('crashed peer (no goodbye) is removed once the server notices', async t => {
  const [a, b] = await call(t);
  (await b.context().newCDPSession(b)).send('Page.crash').catch(() => { }); // never resolves: the renderer is gone
  await waitFor(async () => (await a.locator('#mediaDiv .videoplaceholder').count()) === 1, 'tile removed', 30000);
});

// A crash closes TCP at once; a dead network does not: the server notices only by its ping timeout (10-20s).
test('a peer whose network dies while its socket looks open is removed once the server notices', async t => {
  const [a, b] = await call(t, null, trackPcs);
  const cdp = await b.context().newCDPSession(b);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 1e5, downloadThroughput: 1, uploadThroughput: 1 }); // socket stalls but stays open (offline would close it)
  await a.evaluate(() => Object.values(pcs)[0].mappedEvents.close = []); // a dead network sends no goodbye
  await b.evaluate(() => __raw[0].close()); // ICE is not throttled: end it like this
  await waitFor(async () => (await peerStatus(a)) === 'reconnecting…', 'reconnecting shown');
  assert.ok(await a.evaluate(() => !Object.values(pcs)[0].left), 'bob still on the server: tile kept');
  await waitFor(async () => (await a.locator('#mediaDiv .videoplaceholder').count()) === 1, 'tile removed', 30000);
});

// Both ends switch networks at once: on reconnect each drops its dead call, and the two rejoins make one new one.
// The server sends userJoined only one way (joins are handled one at a time); if it ever sends it both ways, the offers glare: needs a UUID tie-break.
test('both sockets drop at once with ICE gone: one new call', async t => {
  const [a, b] = await call(t, trackPcs, trackPcs);
  for (const p of [a, b]) await p.evaluate(() => Object.values(pcs)[0].mappedEvents.close = []); // a lost network sends no goodbye
  await Promise.all([a, b].map(p => p.evaluate(() => { __raw[0].close(); socket.io.engine.close(); })));
  for (const p of [a, b]) await waitFor(() => callUp(p), 'call up again', 30000);
  for (const p of [a, b]) assert.strictEqual(await p.evaluate(() => __raw.length), 2, 'one new connection each');
});

test('three peers: chat, mute and a screen share started mid-call reach both others; one crashes, the other two keep talking', async t => {
  const [a, b] = await call(t);
  const c = await join(t, 'carol');
  for (const p of [a, b, c]) await waitFor(async () => (await connectedPeers(p)) === 2 && (await liveRemoteAudio(p)) === 2, 'full mesh');
  const bId = await b.evaluate(() => MY_UUID);
  await chat(a, 'hi both');
  await b.click('#muteUnmuteMicBtn');
  await c.click('#addRemoveScreenBtn'); // carol is the answerer on both connections
  for (const p of [b, c]) await waitFor(() => p.evaluate(() => $('#chatText').textContent == 'alice: hi both'), 'chat from alice');
  for (const p of [a, c]) await waitFor(() => p.evaluate(id => !!allUserStreams[id]?.tile?.querySelector('.audioMuted'), bId), 'bob muted');
  for (const p of [a, b]) await waitFor(() => remoteVideoShown(p), 'carol\'s screen');
  (await b.context().newCDPSession(b)).send('Page.crash').catch(() => { }); // never resolves: the renderer is gone
  for (const p of [a, c]) await waitFor(() => p.evaluate(id => !allUserStreams[id]?.tile?.isConnected, bId), 'bob removed', 30000);
  for (const p of [a, c]) assert.ok(await callUp(p), 'alice and carol still talking');
  await waitFor(() => remoteVideoShown(a), 'carol\'s screen still on alice', 5000); // the re-layout sets srcObject again: videoWidth is 0 until the next frame
});

// #14: each side asks for Opus DTX + FEC, so a muted mic sends almost nothing.
test('Opus DTX/FEC requested; muting drops the audio packet rate', async t => {
  // Per spec RTCSessionDescription.sdp is readonly (Firefox/Safari ignore writes); Chrome lets it be assigned. Before trackPcs: it patches the real prototype.
  const readonlySdp = () => {
    const g = Object.getOwnPropertyDescriptor(RTCPeerConnection.prototype, 'localDescription').get;
    Object.defineProperty(RTCPeerConnection.prototype, 'localDescription', { get() { const d = g.call(this); return d && Object.freeze({ type: d.type, sdp: d.sdp }); } });
  };
  const init = `(${readonlySdp})(); (${trackPcs})();`;
  const [a, b] = await call(t, init, init);
  for (const p of [a, b]) {
    const fmtp = await p.evaluate(() => { const s = __raw[0].remoteDescription.sdp, pt = s.match(/a=rtpmap:(\d+) opus\//)[1]; return s.match(new RegExp('a=fmtp:' + pt + ' .*'))[0]; });
    assert.match(fmtp, /usedtx=1/); assert.match(fmtp, /useinbandfec=1/);
  }
  // fmtp is the receiver's wish: alice's encoder follows bob's SDP, so measure alice's outbound packets.
  // Without DTX it is ~100 packets/2s even when muted; the fake mic's beep has gaps, so unmuted is ~60 with DTX.
  const sent2s = () => a.evaluate(async () => {
    const n = async () => { let x = 0; (await __raw[0].getStats()).forEach(r => { if (r.type == 'outbound-rtp' && r.kind == 'audio') x += r.packetsSent; }); return x; };
    const s = await n(); await new Promise(r => setTimeout(r, 2000)); return (await n()) - s;
  });
  const before = await sent2s();
  await a.click('#muteUnmuteMicBtn');
  await new Promise(r => setTimeout(r, 500));
  const muted = await sent2s();
  await a.click('#muteUnmuteMicBtn');
  await new Promise(r => setTimeout(r, 500));
  const after = await sent2s();
  console.log('audio packets per 2s (unmuted, muted, unmuted):', before, muted, after);
  assert.ok(muted < 20, `muted sent ${muted}`);
  assert.ok(before > 30 && after > 30, `unmuted sent ${before}/${after}`);
  assert.strictEqual(await liveRemoteAudio(b), 1, 'audio still arrives');
});

test('mute button toggles the mic track', async t => {
  const a = await join(t, 'alice');
  await waitFor(() => a.evaluate(() => !!allUserStreams[MY_UUID]), 'mic ready');
  const micEnabled = () => a.evaluate(() => allUserStreams[MY_UUID].audiostream.getAudioTracks()[0].enabled);
  await a.click('#muteUnmuteMicBtn');
  assert.strictEqual(await micEnabled(), false);
  assert.ok(await a.locator('#muteUnmuteMicBtn [href="#microphone-alt-slash"]').count());
  await a.click('#muteUnmuteMicBtn');
  assert.strictEqual(await micEnabled(), true);
});

test('mute clicked before the mic is ready still mutes it', async t => {
  const a = await open(t, 'alice', () => { // mic permission prompt open until __go()
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices), go = new Promise(r => window.__go = r);
    navigator.mediaDevices.getUserMedia = c => go.then(() => gum(c));
  });
  await a.click('#muteUnmuteMicBtn');
  await a.evaluate(() => __go());
  await waitFor(() => a.evaluate(() => !!allUserStreams[MY_UUID].audiostream), 'mic ready');
  assert.strictEqual(await a.evaluate(() => allUserStreams[MY_UUID].audiostream.getAudioTracks()[0].enabled), false);
});

test('a socketdomain in the link cannot move signaling to another server', async t => {
  const a = await open(t, 'alice', null, '?socketdomain=evil.example');
  assert.strictEqual(await a.evaluate(() => socket.io.engine.hostname), '127.0.0.1', 'own server');
});

test('a peer named like an Object.prototype key is an ordinary peer', async t => {
  const a = await join(t, 'alice');
  await waitFor(async () => (await selfStatus(a)) === '', 'joined'); // the join's resync drops peers the server doesn't list
  await a.evaluate(() => socket.listeners('userJoined')[0]({ UUID: '__proto__', keep: [] }));
  assert.deepStrictEqual(await a.evaluate(() => [Object.keys(pcs), !!allUserStreams['__proto__'].tile?.isConnected, 'status' in {}]), [['__proto__'], true, false]);
});

// #60: a peer picks its own UUID. "Streams" made 'audio' + UUID the id of #audioStreams: no audio for it, and its leaving removed everyone's.
test('a peer whose UUID spells a page element id is an ordinary peer (#60)', async t => {
  const [a] = await call(t);
  const m = await join(t, 'mallory', () => { const r = crypto.randomUUID.bind(crypto); let n = 0; crypto.randomUUID = () => n++ ? r() : 'Streams'; }); // first call: MY_UUID
  assert.strictEqual(await m.evaluate(() => MY_UUID), 'Streams');
  await waitFor(async () => (await liveRemoteAudio(a)) === 2, 'mallory heard too');
  assert.strictEqual(await a.locator('#mediaDiv [id], #audioStreams [id]').count(), 0, 'no peer UUID as an element id (e.g. "chatText", "moreGroup")');
  await m.context().close();
  await waitFor(() => a.evaluate(() => Object.keys(pcs).length === 1), 'mallory left');
  assert.strictEqual(await a.locator('#audioStreams').count(), 1, '#audioStreams kept');
  assert.strictEqual(await liveRemoteAudio(a), 1, 'bob still heard');
});

test('icons: every one used is in the sprite, with its CC BY credit', async t => {
  const a = await open(t, 'alice');
  const [html, js] = await Promise.all(['', 'js/main.js'].map(async f => (await fetch(BASE + f)).text()));
  const used = [...(html + js).matchAll(/href="#([\w-]+)"|icon\(([^)]*)\)/g)].flatMap(m => m[1] ? [m[1]] : [...m[2].matchAll(/"([\w-]+)"/g)].map(q => q[1]));
  assert.ok(new Set(used).size >= 16, `found ${new Set(used).size}`);
  assert.deepStrictEqual(await a.evaluate(used => used.filter(n => !document.querySelector('symbol#' + n)), used), [], 'missing in the sprite');
  assert.strictEqual(await a.evaluate(() => document.querySelector('body > svg').getClientRects().length), 0, 'the sprite takes no space');
  assert.ok(html.includes('Font Awesome Free 5.13.1 by @fontawesome - https://fontawesome.com') && html.includes('CC BY 4.0'), 'credit in the sprite');
  assert.ok((await (await fetch(BASE + 'icons-LICENSE.txt')).text()).startsWith('Font Awesome Free License'));
});

test('end screen: how long, with whom, the chat, stats for nerds and a new call', async t => {
  const a = await join(t, 'alice', () => { navigator.clipboard.writeText = t => { window.__copied = t; return Promise.resolve(); }; });
  const b = await join(t, 'bob');
  await waitFor(() => a.evaluate(() => Object.keys(pcs).some(id => nameOf(id) == 'bob' && pcs[id].iceUp())), 'in a call with bob');
  await b.evaluate(() => { $('#chatInputText').value = 'notes: https://example.com/doc'; sendMsg(); });
  await waitFor(() => a.evaluate(() => $('#chatText').textContent.includes('example.com')), 'chat on alice');
  await a.evaluate(() => { $('#chatInputText').value = 'thanks'; sendMsg(); });
  await a.click('#cancelCallBtn');
  await a.waitForURL(/endcall\.html$/, { timeout: 5000 });
  assert.match(await a.locator('#duration').innerText(), /^0:\d\d$/);
  assert.strictEqual(await a.locator('#with').innerText(), 'with bob');
  assert.strictEqual(await a.locator('#stats').isVisible(), false, 'stats for nerds start folded');
  await a.click('#nerdStats summary');
  const stats = await a.locator('#stats').innerText();
  for (const re of [/Connection\s+Direct/, /Round trip\s+\d+ ms/, /Encryption\s+End to end/]) assert.match(stats, re);
  assert.match(await a.locator('#endChat').innerText(), /bob: notes: https:\/\/example\.com\/doc/, 'the chat, to save links from');
  assert.strictEqual(await a.locator('#endChat a').getAttribute('href'), 'https://example.com/doc');
  assert.match(await a.locator('#chatNote').innerText(), /gone once you close this tab/, 'told to save what they need');
  await a.click('#copyChatBtn');
  await waitFor(async () => (await a.locator('#copyChatBtn').innerText()) == 'Copied!', 'copied');
  assert.strictEqual(await a.evaluate(() => window.__copied), 'bob: notes: https://example.com/doc\nalice: thanks', 'the whole chat, one line per message');
  await a.click('#newCallBtn');
  await waitFor(() => a.locator('#lobby').isVisible(), 'lobby of a new call');
  assert.ok(/#roomname=r\d+$/.test(a.url()) && !a.url().includes(room(t)), `a new room: ${a.url()}`);
});

test('browsers without WebRTC get an upgrade notice', async t => {
  const a = await open(t, 'alice', () => { delete window.RTCPeerConnection; });
  await waitFor(() => a.locator('#unsupported').isVisible(), 'notice visible', 5000);
  assert.match(await waitFor(() => state(t).errors.pop(), 'the page error'), /WebRTC not supported/);
});

test('browsers without crypto.randomUUID (Safari < 15.4) get the notice too', async t => {
  const a = await open(t, 'alice', () => { delete Crypto.prototype.randomUUID; });
  await waitFor(() => a.locator('#unsupported').isVisible(), 'notice visible', 5000);
  assert.match(await waitFor(() => state(t).errors.pop(), 'the page error'), /WebRTC not supported/);
});

// Dropping UDP breaks the direct P2P path while signaling (TCP) stays up. Needs root for iptables.
const canDropUdp = (() => { try { require('child_process').execSync('iptables -L -n', { stdio: 'ignore' }); return true; } catch { return false; } })();
const iptables = args => require('child_process').execSync('iptables ' + args);
const DROP = '-m comment --comment basicwebrtc-test -j DROP';
async function withoutUdp(fn, rule = 'OUTPUT -p udp ! --dport 53') {
  for (const r of String(iptables('-S OUTPUT')).split('\n')) if (r.includes('basicwebrtc-test')) iptables(r.replace('-A', '-D')); // leftovers from a killed run
  iptables(`-I ${rule} ${DROP}`);
  try { await fn(); } finally { iptables(`-D ${rule} ${DROP}`); }
}

// 45s: a restart that fails while the path is still down must not end the retries (#22). Opt-in: it takes ~50s.
for (const outage of [15, 45]) test(`call recovers after the direct P2P path drops for ${outage}s`, { skip: !canDropUdp ? 'needs root + iptables' : outage > 15 && !process.env.SLOW && 'set SLOW=1' }, async t => {
  const [a, b] = await call(t, trackPcs, trackPcs);
  await withoutUdp(async () => {
    await waitFor(async () => !(await iceUp(a)) && !(await iceUp(b)), 'ICE disconnected', 15000);
    await waitFor(async () => (await peerStatus(a)) === 'reconnecting…' && (await peerStatus(b)) === 'reconnecting…', 'reconnecting shown');
    await new Promise(r => setTimeout(r, outage * 1000)); // 15s: longer than any give-up timeout; 45s: #22
  });
  for (const p of [a, b]) {
    await waitFor(async () => (await iceUp(p)) && (await liveRemoteAudio(p)) === 1, 'ICE and audio back', 45000);
    assert.strictEqual(await p.evaluate(() => Object.keys(pcs).length), 1, 'peer kept');
    assert.strictEqual(await p.evaluate(() => __raw.length), 1, 'same connection, not rebuilt');
    await waitFor(async () => (await peerStatus(p)) === '', 'status cleared');
  }
});

// #25: an answer still in flight when ICE restarts must not be applied to the restart offer.
test('late answer does not cancel an ICE restart', { skip: !canDropUdp && 'needs root + iptables' }, async t => {
  const [a, b] = await call(t, trackPcs, trackPcs);
  const ufrag = (p, d) => p.evaluate(d => __raw[0][d].sdp.match(/a=ice-ufrag:(\S+)/)[1], d);
  const bobUfrag = await ufrag(b, 'localDescription');
  await a.evaluate(() => { // once alice has sent an ICE restart offer, deliver the answers held back until then, in order
    const uf = () => __raw[0].localDescription.sdp.match(/a=ice-ufrag:(\S+)/)[1], u0 = uf();
    window.__restarted = new Promise(r => { const t = setInterval(() => uf() != u0 && (clearInterval(t), r()), 50); });
    window.__answers = 0;
  });
  await onSignaling(a, (d, orig) => d?.type == 'answer' ? __restarted.then(() => orig(d)).finally(() => __answers++) : orig(d)); // hold bob's answers
  await a.click('#addRemoveCameraBtn'); // offer whose answer is held back
  await withoutUdp(async () => {
    await waitFor(async () => (await a.evaluate(() => __answers >= 2 && __raw[0].signalingState == 'stable')) && (await ufrag(b, 'localDescription')) != bobUfrag, 'restart answered', 30000);
    assert.strictEqual(await ufrag(a, 'currentRemoteDescription'), await ufrag(b, 'localDescription'), 'alice uses bob\'s new ICE credentials');
  });
  for (const p of [a, b]) await waitFor(async () => (await iceUp(p)) && (await liveRemoteAudio(p)) === 1, 'ICE and audio back', 45000);
});

// #4: only bob's connectivity checks get lost; alice's checks and bob's replies pass, so only bob's ICE fails.
// The drop matches bob's current port only: an ICE restart gathers new ports and gets through.
test('call recovers when only the answerer sees ICE fail', { skip: !canDropUdp && 'needs root + iptables' }, async t => {
  const [a, b] = await call(t, trackPcs, trackPcs);
  const port = await b.evaluate(async () => { // bob's end of the candidate pair in use
    const stats = await __raw[0].getStats(), transport = [...stats.values()].find(x => x.type == 'transport');
    return stats.get(stats.get(transport.selectedCandidatePairId).localCandidateId).port;
  });
  await withoutUdp(async () => {
    await waitFor(() => b.evaluate(() => !Object.values(pcs)[0].iceUp()), 'bob\'s ICE down', 20000);
    assert.ok(await a.evaluate(() => Object.values(pcs)[0].iceUp()), 'alice\'s ICE still up');
    for (const p of [a, b]) await waitFor(() => callUp(p), 'call up again', 45000);
  }, `OUTPUT -p udp --sport ${port} -m u32 --u32 "0>>22&0x3C@8>>16=0x1"`); // bob's STUN binding requests only
  for (const p of [a, b]) assert.strictEqual(await p.evaluate(() => __raw.length), 1, 'same connection, not rebuilt');
});

test('three peers: one pair loses ICE, it comes back, the others are not disturbed', { skip: !canDropUdp && 'needs root + iptables' }, async t => {
  const [a, b] = await call(t, trackPcs, trackPcs);
  const c = await join(t, 'carol', trackPcs);
  for (const p of [a, b, c]) await waitFor(async () => (await connectedPeers(p)) === 2, 'full mesh');
  const ufrags = p => p.evaluate(() => __raw.map(x => x.localDescription.sdp.match(/a=ice-ufrag:(\S+)/)[1]));
  const before = await Promise.all([a, b, c].map(ufrags));
  for (const p of [a, b, c]) await p.evaluate(() => __raw.forEach(x => x.addEventListener('iceconnectionstatechange', () => x.iceConnectionState == 'disconnected' && (x.wentDown = true))));
  const port = await a.evaluate(async () => { // alice's end of the alice-bob path (joined in that order: __raw[0] on both)
    const s = await __raw[0].getStats();
    const pair = s.get([...s.values()].find(r => r.type == 'transport').selectedCandidatePairId);
    return s.get(pair.localCandidateId).port;
  });
  await withoutUdp(() => waitFor(async () => (await a.evaluate(() => __raw[0].wentDown)) && (await b.evaluate(() => __raw[0].wentDown)), 'alice-bob ICE down', 30000), `OUTPUT -p udp --sport ${port}`);
  for (const p of [a, b]) await waitFor(() => p.evaluate(() => ['connected', 'completed'].includes(__raw[0].iceConnectionState)), 'alice-bob back', 30000);
  assert.deepStrictEqual([await a.evaluate(() => __raw[1].wentDown), await b.evaluate(() => __raw[1].wentDown), await c.evaluate(() => __raw.some(x => x.wentDown))], [undefined, undefined, false], 'other pairs stayed up');
  const after = await Promise.all([a, b, c].map(ufrags));
  assert.deepStrictEqual([after[0][1], after[1][1], after[2]], [before[0][1], before[1][1], before[2]], 'and were not restarted');
  for (const p of [a, b, c]) assert.strictEqual(await p.evaluate(() => __raw.length), 2, 'no connection rebuilt');
});

// #56: the test server uses iceservers.example.json, so public STUN only. No UDP: the call can never connect.
test('no TURN configured and ICE fails: the tile says so instead of "connecting…" forever', { skip: !canDropUdp && 'needs root + iptables' }, async t => {
  await withoutUdp(async () => {
    const a = await join(t, 'alice'), b = await join(t, 'bob');
    const hint = "no relay configured: some networks can't connect";
    await waitFor(async () => (await peerStatus(a)) === hint && (await peerStatus(b)) === hint, 'no relay hint', 30000);
    await a.evaluate(() => { // as if TURN were configured; the server's STUN-only list must not overwrite it
      socket.off('currentIceServers');
      webRTCConfig.iceServers = [{ urls: ['turn:turn.example.com:443', 'turns:turn.example.com:443?transport=tcp'] }];
    });
    await waitFor(async () => (await peerStatus(a)) === 'connecting…', 'no hint with TURN configured', 30000);
  });
});

test('rename updates the name for peers and chat, survives a reload, stays out of the URL', async t => {
  const [a, b] = await call(t);
  a.once('dialog', d => d.accept('zoe smith'));
  await a.click('#moreBtn'); await a.click('#changeNameBtn');
  await waitFor(() => b.evaluate(() => Object.values(allUserStreams).some(s => s.username == 'zoe smith')), 'new name on bob');
  assert.strictEqual(await b.evaluate(() => document.querySelector('#mediaDiv').textContent.includes('ZO')), true, 'initials updated');
  assert.strictEqual(await a.evaluate(() => location.hash), `#roomname=${room(t)}`, 'name not in the URL');
  await chat(a, 'hi');
  await waitFor(() => b.evaluate(() => document.querySelector('#chatText').textContent.includes('zoe smith: hi')), 'chat uses new name');
  await a.reload();
  assert.strictEqual(await a.evaluate(() => username), 'zoe smith', 'kept for reloads in this tab');
});

test('share link is just the room, whatever else the URL holds', async t => {
  const a = await join(t, 'alice', () => { navigator.share = d => { window.__shared = d; return Promise.resolve(); }; }, `?username=bob&camon=true&x=1`);
  await a.click('#moreBtn'); await a.click('#shareBtn');
  const shared = await a.evaluate(() => window.__shared);
  assert.strictEqual(shared.url, `${BASE}#roomname=${room(t)}`);
  assert.strictEqual(await a.evaluate(() => username), 'alice', '?username= ignored too');
});

test('old link params are ignored: username, camon', async t => {
  const a = await (await context(t)).newPage();
  await a.goto(`${BASE}#roomname=${room(t)}&username=bob&camon=true`);
  await waitFor(() => a.locator('#lobby').isVisible(), 'lobby shown');
  assert.deepStrictEqual(await a.evaluate(() => [username, $('#nameInput').value, $('#lobbyCamera').value]), ['NA', '', 'off']);
});

test('URL params: missing room gets a fresh one; "+", "=" and a stray % stay as typed', async t => {
  const a = await (await context(t)).newPage();
  await a.goto(`${BASE}#username=bob`); // no roomname: a fresh room, old params dropped
  assert.match(await a.evaluate(() => location.hash), /^#roomname=r\d+$/);
  assert.strictEqual(await a.locator('#intro').isVisible(), true, 'a fresh visit says what this is');
  await a.goto(`${BASE}#roomname=a+b=100%`); // hash-only: the page reloads itself
  await waitFor(() => a.evaluate(() => roomname == 'a+b=100%').catch(() => false), 'room a+b=100%');
  assert.strictEqual(await a.locator('#intro').isVisible(), false, 'invited: straight to the join form');
});

test('a room link pasted into an open tab goes to that room', async t => {
  const a = await open(t, 'alice');
  await waitFor(() => a.locator('#lobby').isVisible(), 'lobby shown');
  const other = room(t) + 'b';
  await a.evaluate(r => location.hash = 'roomname=' + r, other); // hash-only change: no reload by itself
  await waitFor(() => a.evaluate(r => roomname == r, other).catch(() => false), 'page on the new room');
});

test('the same room link again, or with old params, does not reload the call', async t => {
  const a = await join(t, 'alice');
  assert.strictEqual(await a.evaluate(r => new Promise(done => {
    let reload = false;
    navigation.addEventListener('navigate', e => reload ||= !e.hashChange);
    addEventListener('hashchange', () => done(reload)); // after the page's own handler
    location.hash = 'roomname=' + r + '&username=bob';
  }), room(t)), false, 'no reload');
});

test('share falls back to a copy dialog when Web Share fails', async t => {
  const a = await join(t, 'alice', () => { navigator.share = () => Promise.reject(new DOMException('no', 'NotAllowedError')); });
  await a.click('#moreBtn'); await a.click('#shareBtn');
  await waitFor(() => a.locator('#shareDialog').isVisible(), 'share dialog');
  assert.strictEqual(await a.inputValue('#shareLink'), `${BASE}#roomname=${room(t)}`);
});

test('without Web Share the dialog copies the link', async t => {
  const a = await join(t, 'alice', () => {
    delete Navigator.prototype.share;
    navigator.clipboard.writeText = t => { window.__copied = t; return Promise.resolve(); };
  });
  await a.click('#moreBtn'); await a.click('#shareBtn');
  await a.click('#copyLinkBtn');
  assert.strictEqual(await a.evaluate(() => window.__copied), `${BASE}#roomname=${room(t)}`);
  await a.click('#shareDialog button[value=close]');
  assert.strictEqual(await a.locator('#shareDialog').isVisible(), false);
});

const PHONE = { viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true };

test('camera picker is a touch-sized tab on top of the camera button', async t => {
  const a = await join(t, null, null, '', PHONE);
  await waitFor(() => a.locator('#selectCameraBtn').isVisible(), 'picker visible');
  const [cam, pick] = await Promise.all(['#addRemoveCameraBtn', '#selectCameraBtn'].map(s => a.locator(s).boundingBox()));
  assert.ok(pick.y + pick.height <= cam.y + 1 && Math.abs(pick.x - cam.x) <= 1 && Math.abs(pick.width - cam.width) <= 1, 'tab right above the camera button');
  assert.ok(pick.height >= 24 && pick.width >= 40, `touch-sized (${pick.width}x${pick.height})`);
  await a.mouse.click(cam.x + cam.width - 4, cam.y + cam.height / 2); // the button's right edge still toggles the camera
  await waitFor(() => a.evaluate(() => camActive), 'camera on');
});

test('peer joining during fullscreen is still heard', t =>
  call(t, () => Object.defineProperty(document, 'fullscreenElement', { get: () => document.body })));

// iOS Safari may refuse to start remote audio without a user gesture: the next tap must start it.
test('remote audio blocked by autoplay starts on the next tap', async t => {
  const blockAutoplay = () => { // not userActivation: page.evaluate counts as a gesture
    let tapped = false;
    window.addEventListener('click', e => tapped ||= e.target.id != 'joinBtn', true); // Join is a tap too: this tests a later one
    document.addEventListener('play', e => { if (!tapped) e.target.pause(); }, true);
  };
  const [a] = await call(t, blockAutoplay);
  const paused = () => a.evaluate(() => document.querySelector('#audioStreams audio').paused);
  await waitFor(paused, 'autoplay blocked');
  await a.mouse.click(5, 5);
  await waitFor(async () => !(await paused()), 'audio playing after tap');
});

test('chat opens fullscreen on phones and closes again', async t => {
  const a = await join(t, null, null, '', PHONE);
  await a.click('#moreBtn'); await a.click('#addRemoveChatBtn');
  assert.notStrictEqual(await a.evaluate(() => document.activeElement.id), 'chatInputText', 'no keyboard popping up on touch');
  const box = await a.locator('#chatDiv').boundingBox();
  assert.deepStrictEqual([box.x, box.y, box.width, box.height], [0, 0, 320, 568]);
  assert.ok(parseFloat(await a.$eval('#chatInputText', e => getComputedStyle(e).fontSize)) >= 16, 'no iOS zoom on focus');
  await a.click('#chatCloseBtn');
  assert.strictEqual(await a.locator('#chatDiv').isVisible(), false);
});

test('unnamed sender cannot fake a styled name', async t => {
  const a = await join(t, null);
  const b = await join(t, 'bob');
  await waitFor(async () => (await connectedPeers(b)) === 1, 'ICE connected');
  await chat(a, 'bob: send me the code');
  await waitFor(() => b.evaluate(() => document.querySelectorAll('#chatText > div').length > 0), 'message on bob');
  assert.strictEqual(await b.evaluate(() => document.querySelector('#chatText .chatName')), null);
});

test('desktop chat fits short windows above the phone breakpoint', async t => {
  const a = await join(t, null, null, '', { viewport: { width: 1000, height: 500 } });
  await a.click('#moreBtn'); await a.click('#addRemoveChatBtn');
  assert.ok((await a.locator('#chatDiv').boundingBox()).y >= 0, 'header on screen');
  await a.click('#chatCloseBtn');
  assert.strictEqual(await a.locator('#chatDiv').isVisible(), false);
});

test('Enter in the share link keeps the dialog open', async t => {
  const a = await join(t, 'alice', () => { delete Navigator.prototype.share; });
  await a.click('#moreBtn'); await a.click('#shareBtn');
  await a.press('#shareLink', 'Enter');
  assert.strictEqual(await a.locator('#shareDialog').isVisible(), true);
});

test('chat, rename and share live in the more menu', async t => {
  const a = await join(t, 'alice');
  const items = ['#addRemoveChatBtn', '#changeNameBtn', '#shareBtn'];
  const visible = () => Promise.all(items.map(s => a.locator(s).isVisible()));
  assert.deepStrictEqual(await visible(), [false, false, false], 'not in the bar');
  await a.click('#moreBtn');
  assert.deepStrictEqual(await visible(), [true, true, true], 'menu open');
  await a.mouse.click(5, 5);
  assert.deepStrictEqual(await visible(), [false, false, false], 'outside click closes');
  // unread chat is flagged on the more button while chat is closed
  const unread = () => a.evaluate(() => [document.querySelector('#moreBtn').dataset.unread, document.querySelector('#addRemoveChatBtn').dataset.unread]);
  await a.evaluate(() => { showMsg('', 'ping'); showMsg('', 'pong'); });
  await waitFor(async () => (await unread())[0] === '2', 'unread count badge');
  assert.deepStrictEqual(await unread(), ['2', '2'], 'count on the button and the chat item');
  await a.click('#moreBtn'); await a.click('#addRemoveChatBtn');
  assert.strictEqual(await a.locator('#moreMenu').isVisible(), false, 'picking an item closes the menu');
  assert.deepStrictEqual(await unread(), [undefined, undefined], 'read');
});

const noScreenShare = () => { delete MediaDevices.prototype.getDisplayMedia; }; // phone browsers: no getDisplayMedia

test('all call buttons fit on screen from phone to small desktop widths', async t => {
  for (const [width, height] of [[320, 568], [568, 320], [520, 800], [600, 800]]) { // with the screen share button: the widest bar
    const a = await join(t, null, null, '', { viewport: { width, height } });
    await waitFor(() => a.locator('#selectCameraBtn').isVisible(), 'camera picker shown (2 fake cams)');
    const overflow = await a.evaluate(() => [...document.querySelectorAll('.callBtn')]
      .filter(b => b.offsetParent && b.getBoundingClientRect().right > innerWidth).map(b => b.id));
    assert.deepStrictEqual(overflow, [], `${width}x${height}`);
    await a.context().close(); // alone in the room: the next size joins it
  }
});

// iPhone notch / home indicator, emulated by Chromium. ins = [top, right, bottom, left]; Chromium applies them with or without viewport-fit.
async function notched(t, opts, ins, path = '') {
  const page = await (await context(t, opts)).newPage();
  const [top, right, bottom, left] = ins;
  await (await page.context().newCDPSession(page)).send('Emulation.setSafeAreaInsetsOverride', { insets: { top, right, bottom, left } });
  await page.goto(`${BASE}${path}#roomname=${room(t)}`);
  return page;
}
// Visible elements matching sels that reach into the insets.
const unsafe = (page, sels, ins) => page.evaluate(([sels, [top, right, bottom, left]]) => sels.flatMap(s => [...document.querySelectorAll(s)])
  .filter(e => e.getClientRects().length && getComputedStyle(e).visibility != 'hidden')
  .filter(e => { const r = e.getBoundingClientRect(); return r.top < top - .5 || r.right > innerWidth - right + .5 || r.bottom > innerHeight - bottom + .5 || r.left < left - .5; })
  .map(e => e.id || e.className), [sels, ins]);

test('safe areas: nothing to tap or read sits under the notch or the home indicator', async t => {
  for (const [w, h, ins] of [[390, 844, [47, 0, 34, 0]], [844, 390, [0, 47, 21, 47]]]) {
    const opts = { viewport: { width: w, height: h }, hasTouch: true, isMobile: true }, size = `${w}x${h}`;
    for (const path of ['', 'endcall.html']) {
      const p = await notched(t, opts, ins, path);
      assert.match(await p.$eval('meta[name=viewport]', m => m.content), /viewport-fit=cover/, `${path || 'index.html'}: without it iOS reports no insets`);
      if (path) assert.deepStrictEqual(await unsafe(p, ['#endCard', '#newCallBtn'], ins), [], `end page ${size}`);
      else assert.deepStrictEqual(await unsafe(p, ['#lobby'], ins), [], `lobby ${size}`);
      await p.context().close();
    }
    const a = await notched(t, opts, ins);
    await a.click('#joinBtn');
    const b = await join(t, 'bob');
    await waitFor(async () => (await callUp(a)) && (await callUp(b)), 'call up');
    await a.click('#addRemoveCameraBtn'); await b.click('#addRemoveCameraBtn'); // name tags and PiP buttons
    await waitFor(() => a.evaluate(() => document.querySelectorAll('#mediaDiv video').length == 2), 'both videos');
    assert.deepStrictEqual(await unsafe(a, ['#mediaControll', '.callBtn', '.selfPreview', '.userName', '.pipBtn', '#knocks'], ins), [], `call ${size}`);
    await a.click('#moreBtn'); await a.click('#addRemoveChatBtn');
    assert.deepStrictEqual(await unsafe(a, ['#chatHeader', '#chatCloseBtn', '#chatInputRow'], ins), [], `chat ${size}`);
    await Promise.all([a.context().close(), b.context().close()]);
  }
});

test('one look: the call bar has labels, the page and its panels share one font', async t => {
  const a = await join(t, 'alice');
  const labels = await a.evaluate(() => [...document.querySelectorAll('.callBtn')].filter(b => b.offsetParent).map(b => b.innerText.trim()));
  assert.deepStrictEqual(labels, ['Mic', 'Camera', 'Screen', 'More', 'Leave']);
  await a.click('#muteUnmuteMicBtn');
  assert.strictEqual(await a.locator('#muteUnmuteMicBtn').innerText(), 'Mic', 'muting swaps the icon, not the label');
  const fonts = await a.evaluate(() => ['body', '#lobby', '#chatDiv', '#moreMenu', '#shareDialog', '#mediaControll'].map(s => getComputedStyle(document.querySelector(s)).fontFamily));
  assert.strictEqual(new Set(fonts).size, 1, fonts.join(' | '));
});

test('person colours: a peer\'s circle and chat name share one colour', async t => {
  const [a, b] = await call(t);
  await chat(b, 'hi');
  await waitFor(() => a.evaluate(() => document.querySelector('#chatText .chatName')), 'bob\'s message');
  const [circle, name] = await a.evaluate(() => {
    const bob = Object.keys(pcs)[0];
    return [getComputedStyle(allUserStreams[bob].tile.querySelector('.userPlaceholder')).backgroundColor, getComputedStyle(document.querySelector('#chatText .chatName')).color];
  });
  assert.strictEqual(circle, name);
  const fresh = await (await context(t)).newPage(); // no one seen yet
  await fresh.goto(BASE + 'endcall.html');
  const colors = await fresh.evaluate(() => ['Mara', 'Jonas', 'Ada', 'Mara'].map(personColor)); // Mara and Jonas share a hash bucket
  assert.strictEqual(new Set(colors).size, 3, 'everyone in the call gets their own color, and keeps it: ' + colors);
});

test('person colours: the end page keeps the colours of the call', async t => {
  const a = await join(t, 'Mara'), b = await join(t, 'Jonas'); // one hash bucket: who comes first matters
  await waitFor(async () => (await connectedPeers(a)) === 1, 'ICE connected');
  await chat(b, 'notes are in the pad');
  await waitFor(() => a.evaluate(() => document.querySelector('#chatText .chatName')), 'message on Mara');
  const inCall = await a.evaluate(() => getComputedStyle(document.querySelector('#chatText .chatName')).color);
  await a.click('#cancelCallBtn');
  await a.waitForURL(/endcall\.html$/, { timeout: 5000 });
  assert.strictEqual(await a.evaluate(() => getComputedStyle(document.querySelector('#chatText .chatName')).color), inCall);
});

test('screen share button follows getDisplayMedia, not the user agent', async t => {
  for (const [init, shown] of [[null, true], [noScreenShare, false]]) {
    const a = await join(t, null, init, '', { userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile' });
    assert.strictEqual(await a.locator('#addRemoveScreenBtn').isVisible(), shown, init ? 'no getDisplayMedia' : 'Android with getDisplayMedia');
    await a.context().close();
  }
});

// #26: local media state
const noCamera = () => { const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = c => c.video ? Promise.reject(new DOMException('no camera', 'NotFoundError')) : gum(c); };
const liveVideoLeft = page => page.evaluate(() => __streams.flatMap(s => s.getVideoTracks()).filter(t => t.readyState == 'live').length);
const slowMedia = () => { // records every stream handed out and how many are still pending; camera and screen take 500ms
  const md = navigator.mediaDevices, gum = md.getUserMedia.bind(md), gdm = md.getDisplayMedia.bind(md);
  window.__streams = []; window.__pending = 0;
  const slow = f => async c => { __pending++; const s = await f(c); if (c.video) await new Promise(r => setTimeout(r, 500)); __streams.push(s); __pending--; return s; };
  md.getUserMedia = slow(gum); md.getDisplayMedia = slow(gdm);
};
// Every camera/mic/screen request made so far is answered and handled.
const mediaSettled = page => waitFor(() => page.evaluate(() => !__pending && !mediaBusy), 'media requests done');

test('camera on from last time, but no working camera: still joins with audio', t =>
  call(t, `(${noCamera})(); sessionStorage.camOn ||= '1';`));

test('rapid camera/screen clicks leave no live stream behind', async t => {
  const a = await join(t, 'alice', slowMedia);
  await waitFor(() => a.evaluate(() => !!allUserStreams[MY_UUID].audiostream), 'mic ready');
  await a.click('#addRemoveCameraBtn'); await a.click('#addRemoveCameraBtn'); // double click
  await mediaSettled(a);
  assert.ok(await a.evaluate(() => camActive), 'camera on');
  await a.click('#addRemoveCameraBtn');
  assert.strictEqual(await liveVideoLeft(a), 0, 'double click');
  await a.click('#addRemoveScreenBtn'); await a.click('#addRemoveCameraBtn'); // camera while the screen picker is open
  await mediaSettled(a);
  assert.ok(!(await a.evaluate(() => camActive && screenActive)), 'not both active');
  await a.evaluate(() => (camActive || screenActive) && stopVideo());
  assert.strictEqual(await liveVideoLeft(a), 0, 'camera during screen picker');
});

test('camera off and on while a camera switch is pending: one live camera, the one sent (#84)', async t => {
  const a = await join(t, 'alice', `(${trackPcs})(); (${() => { // records every track handed out; a getUserMedia called while __hold is set waits for __go()
    const md = navigator.mediaDevices, gum = md.getUserMedia.bind(md);
    window.__streams = [];
    md.getUserMedia = async c => { await window.__hold; const s = await gum(c); __streams.push(new MediaStream(s.getTracks())); return s; }; // a copy: the page adds tracks to its streams
  }})();`);
  const b = await join(t, 'bob');
  await waitFor(async () => (await connectedPeers(a)) === 1, 'ICE connected');
  await a.click('#addRemoveCameraBtn');
  for (const fail of [true, false]) { // the switch fails (first: it picks the second camera, not the picker's fallback), or gets a camera
    await waitFor(() => a.evaluate(() => camActive && $('#cameraSelect').options.length > 1), 'camera on, picker filled');
    const other = await a.evaluate(() => [...$('#cameraSelect').options].find(o => o.value != selectedCameraId).value);
    await a.evaluate(([o, fail]) => { // only the switch's getUserMedia waits
      window.__hold = new Promise((ok, no) => window.__go = () => fail ? no(new DOMException('busy', 'NotReadableError')) : ok());
      pick('#cameraSelect', o);
      __hold = null;
    }, [other, fail]);
    await a.click('#addRemoveCameraBtn'); await a.click('#addRemoveCameraBtn'); // off and on again meanwhile
    await waitFor(() => a.evaluate(() => camActive), 'camera on again');
    await a.evaluate(() => __go());
    await waitFor(() => a.evaluate(() => !$('#cameraSelect').disabled), 'switch done');
    assert.strictEqual(await liveVideoLeft(a), 1, `one live camera (switch ${fail ? 'failed' : 'got one'})`);
    assert.ok(await a.evaluate(o => { const t = allUserStreams[MY_UUID].videostream.getVideoTracks()[0]; return t.getSettings().deviceId == o && __raw.at(-1).getSenders().some(s => s.track?.id == t.id) && selectedCameraId == o; }, other), 'the slot sends the camera turned on, still picked');
  }
});

test('cancelling the screen picker keeps the camera', async t => {
  const a = await join(t, 'alice', () => { navigator.mediaDevices.getDisplayMedia = () => Promise.reject(new DOMException('cancelled', 'NotAllowedError')); });
  await a.click('#addRemoveCameraBtn');
  await waitFor(() => a.evaluate(() => camActive), 'camera on');
  await a.click('#addRemoveScreenBtn');
  await waitFor(() => a.evaluate(() => !mediaBusy), 'picker answered');
  assert.ok(await a.evaluate(() => camActive && allUserStreams[MY_UUID].videostream.getVideoTracks()[0].readyState == 'live'));
});

test('unplugged camera turns the camera off', async t => {
  const a = await join(t, 'alice');
  await a.click('#addRemoveCameraBtn');
  await waitFor(() => a.evaluate(() => camActive), 'camera on');
  await a.evaluate(() => allUserStreams[MY_UUID].videostream.getVideoTracks()[0].dispatchEvent(new Event('ended')));
  assert.deepStrictEqual(await a.evaluate(() => [camActive, !!allUserStreams[MY_UUID].videostream, $('#addRemoveCameraBtn').classList.contains('on')]), [false, false, false]); // the button no longer reads as on
});

test('hang up releases mic, camera and socket right away, once', async t => {
  const a = await join(t, 'alice');
  await waitFor(() => a.evaluate(() => !!allUserStreams[MY_UUID].audiostream), 'mic ready');
  await a.click('#addRemoveCameraBtn');
  await waitFor(() => a.evaluate(() => camActive), 'camera on');
  await a.evaluate(() => { window.__tracks = [allUserStreams[MY_UUID].audiostream, allUserStreams[MY_UUID].videostream].flatMap(s => s.getTracks()); });
  await a.evaluate(() => { $('#cancelCallBtn').click(); $('#cancelCallBtn').click(); });
  assert.deepStrictEqual(await a.evaluate(() => [__tracks.map(t => t.readyState).join(), socket.disconnected, document.querySelectorAll('#topDiv').length]), ['ended,ended', true, 1]);
});

test('mic denied shows a message and "Try again" joins once allowed', async t => {
  const a = await open(t, 'alice', () => {
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = c => c.audio && !sessionStorage.micOk ? Promise.reject(new DOMException('denied', 'NotAllowedError')) : gum(c);
  });
  await waitFor(() => a.locator('#micError').isVisible(), 'message shown');
  await a.evaluate(() => sessionStorage.micOk = 1); // user allows the mic
  await a.click('#micError button');
  await a.click('#joinBtn');
  const b = await join(t, 'bob');
  await waitFor(async () => (await liveRemoteAudio(b)) === 1, 'alice heard by bob');
});

// #27: the mute icon survives re-layouts and reaches peers who join later.
test('remote mute icon survives re-layout and is shown to late-joining peers', async t => {
  const [a, b] = await call(t);
  await a.click('#muteUnmuteMicBtn');
  await waitFor(() => b.locator('.audioMuted').count(), 'mute icon on bob');
  const c = await join(t, 'carol');
  const aId = await a.evaluate(() => MY_UUID);
  for (const p of [b, c]) {
    await waitFor(() => p.evaluate(() => document.querySelector('#mediaDiv').textContent.includes('CA')), 'carol\'s tile');
    await waitFor(() => p.evaluate(id => !!allUserStreams[id]?.tile?.querySelector('.audioMuted'), aId), 'alice muted');
  }
  await b.evaluate(() => updateUserLayout()); // any later re-layout keeps it
  assert.ok(await b.evaluate(id => !!allUserStreams[id]?.tile?.querySelector('.audioMuted'), aId), 'still muted after re-layout');
});

test('mute icon on the own tile; unmuting in silence clears it for peers (#83)', async t => {
  const silentMic = () => { const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = c => c.audio ? Promise.resolve(new AudioContext().createMediaStreamDestination().stream) : gum(c); };
  const a = await join(t, 'alice', silentMic); // the meter never sees a level change
  const b = await join(t, 'bob');
  await waitFor(() => b.evaluate(() => document.querySelector('#mediaDiv').textContent.includes('AL')), 'alice\'s tile on bob');
  const aId = await a.evaluate(() => MY_UUID);
  const muted = p => p.evaluate(id => !!allUserStreams[id].tile.querySelector('.audioMuted'), aId);
  const ring = () => a.evaluate(() => allUserStreams[MY_UUID].tile.querySelector('.userPlaceholder').style.getPropertyValue('--level'));
  await a.evaluate(() => setAudioLevel(MY_UUID, 2)); // speaking when the mute is clicked
  await a.click('#muteUnmuteMicBtn');
  await waitFor(() => muted(b), 'mute icon on bob');
  assert.ok(await muted(a), 'own tile shows the mute icon');
  assert.strictEqual(await ring(), '0', 'not lit as speaking while muted');
  await a.click('#muteUnmuteMicBtn');
  await waitFor(async () => !(await muted(b)), 'mute icon gone on bob');
  assert.ok(!(await muted(a)), 'own tile unmuted');
});

test('layout skipped in fullscreen is redone on exit', async t => {
  const [a, b] = await call(t, () => { window.__fs = null; Object.defineProperty(document, 'fullscreenElement', { get: () => window.__fs }); });
  await a.evaluate(() => window.__fs = document.body);
  await b.context().close();
  await waitFor(() => a.evaluate(() => !Object.keys(pcs).length), 'bob removed');
  await a.evaluate(() => { window.__fs = null; document.dispatchEvent(new Event('fullscreenchange')); });
  assert.strictEqual(await a.locator('#mediaDiv .videoplaceholder').count(), 1, 'bob\'s tile gone');
});

test('late signaling from a departed peer creates no connection', async t => {
  const a = await join(t, 'alice');
  await waitFor(() => a.evaluate(() => socket.connected), 'connected');
  await a.evaluate(() => {
    socket.listeners('userDiscconected')[0]('ghost');
    socket.listeners('signaling')[0]({ fromUUID: 'ghost', signalingData: { candidate: 'candidate:1 1 udp 1 1.2.3.4 9 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
  });
  assert.deepStrictEqual(await a.evaluate(() => [Object.keys(pcs), document.querySelectorAll('#mediaDiv .videoplaceholder').length]), [[], 1]);
});

test('tile initials do not split an emoji', async t => {
  const a = await join(t, 'a😀b');
  await waitFor(() => a.evaluate(() => allUserStreams[MY_UUID]?.tile?.querySelector('.userPlaceholder').textContent), 'own tile');
  assert.strictEqual(await a.evaluate(() => allUserStreams[MY_UUID].tile.querySelector('.userPlaceholder').textContent), 'A😀');
});

test('tiles: rows fill the window, a video fits its tile, also right after a resize', async t => {
  const [a, b] = [await join(t, 'alice'), await join(t, 'bob'), await join(t, 'carol')];
  await b.click('#addRemoveCameraBtn');
  await waitFor(() => a.evaluate(() => document.querySelectorAll('#mediaDiv .videoplaceholder').length == 3 && document.querySelector('#mediaDiv video')?.readyState > 0), 'three tiles, bob\'s with video');
  const boxes = () => a.evaluate(() => [...document.querySelectorAll('#mediaDiv .videoplaceholder, #mediaDiv video')]
    .map(e => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round).join(); }));
  // 1280x720: two tiles on top, the third centered below; bob's video (listed after his tile) is as big as his tile allows
  assert.deepStrictEqual(await boxes(), ['0,0,640,360', '640,0,640,360', '640,0,640,360', '320,360,640,360']);
  await a.setViewportSize({ width: 1280, height: 400 });
  assert.deepStrictEqual(await boxes(), ['0,0,640,200', '640,0,640,200', '640,0,640,200', '320,200,640,200'], 'no re-layout needed');
});

test('picture-in-picture survives a re-layout (#27)', async t => {
  const [a, b] = await call(t);
  await a.click('#addRemoveCameraBtn');
  await waitFor(() => remoteVideoShown(b), 'remote video on bob');
  await b.click('#mediaDiv .pipBtn');
  await waitFor(() => b.evaluate(() => !!document.pictureInPictureElement), 'bob in PiP');
  await join(t, 'carol'); // peer joins: re-layout on bob
  await waitFor(async () => (await connectedPeers(b)) === 2, 'carol connected');
  assert.ok(await b.evaluate(() => document.pictureInPictureElement?.isConnected && !document.pictureInPictureElement.paused), 'still in PiP and playing');
});

test('lobby: nobody joins until Join, then with the name typed there', async t => {
  const a = await join(t, 'alice');
  const b = await open(t, null);
  await waitFor(() => b.locator('#lobby').isVisible(), 'lobby shown');
  for (const s of ['#mediaControllContainer', '#mediaDiv']) assert.strictEqual(await b.locator(s).isVisible(), false, `${s} hidden in the lobby`);
  assert.strictEqual(await b.inputValue('#lobbyCamera'), 'off', 'camera off');
  assert.strictEqual(await b.locator('#lobbyVideo').isVisible(), false);
  const cam = await b.evaluate(() => [...document.querySelectorAll('#lobbyCamera option')].at(-1).value);
  await b.selectOption('#lobbyCamera', cam);
  await waitFor(() => b.evaluate(c => $('#lobbyVideo').srcObject?.getVideoTracks()[0]?.getSettings().deviceId == c && $('#lobbyVideo').checkVisibility(), cam), 'preview of the picked camera');
  await b.selectOption('#lobbyCamera', 'off');
  await waitFor(() => b.evaluate(() => !camActive && !$('#lobbyVideo').checkVisibility()), 'camera off again');
  assert.ok(await b.evaluate(() => $('#lobbyMic').options.length > 1 && $('#micMeter') instanceof HTMLMeterElement), 'mic picker and level meter');
  await serverSync(b); await serverSync(a); // a join of bob's would have reached alice by now
  assert.strictEqual(await a.evaluate(() => Object.keys(pcs).length), 0, 'not joined from the lobby');
  assert.deepStrictEqual(await b.evaluate(() => ['data-1p-ignore', 'data-lpignore', 'data-bwignore', 'data-form-type'].map(a => $('#nameInput').hasAttribute(a))), [true, true, true, true], 'password managers told to skip the name field');
  await b.fill('#nameInput', 'carol');
  await b.click('#joinBtn');
  assert.strictEqual(await b.locator('#lobby').isVisible(), false, 'lobby closed');
  assert.ok(await b.locator('#mediaControllContainer').isVisible(), 'call controls shown');
  await waitFor(async () => (await connectedPeers(a)) === 1, 'ICE connected');
  await waitFor(() => a.evaluate(() => Object.values(allUserStreams).some(s => s.username == 'carol')), 'name from the lobby');
});

// The track the sender actually transmits, on the raw RTCPeerConnection.
const sentMicId = page => page.evaluate(() => __raw.at(-1).getSenders().find(s => s.track?.kind == 'audio')?.track.getSettings().deviceId);

test('mic picker switches the mic sent to the other peer', async t => {
  const [a, b] = await call(t, trackPcs);
  await waitFor(() => a.locator('#selectMicBtn').isVisible(), 'mic picker visible');
  const cur = await sentMicId(a);
  const other = await a.evaluate(cur => [...document.querySelectorAll('#micSelect option')].find(o => o.value != cur && o.value != 'default').value, cur);
  await a.selectOption('#micSelect', other);
  await waitFor(async () => (await sentMicId(a)) === other, 'sent mic switched');
  assert.strictEqual(await a.evaluate(() => webRTCConfig.stream.getAudioTracks().length), 1, 'one mic track');
  await waitFor(async () => (await liveRemoteAudio(b)) === 1, 'remote audio after switch');
});

test('an unplugged mic is replaced by another one, the call keeps sound', async t => {
  const hideUnplugged = () => {
    const md = navigator.mediaDevices, enumerate = md.enumerateDevices.bind(md);
    md.enumerateDevices = async () => (await enumerate()).filter(d => d.deviceId != window.__unplugged);
  };
  const [a, b] = await call(t, `(${trackPcs})(); (${hideUnplugged})();`);
  const old = await a.evaluate(() => { // unplug: the device leaves the list, its track ends
    const t = webRTCConfig.stream.getAudioTracks()[0];
    window.__unplugged = t.getSettings().deviceId;
    t.stop(); t.dispatchEvent(new Event('ended'));
    return t.id;
  });
  await waitFor(() => a.evaluate(old => { const t = __raw.at(-1).getSenders().find(s => s.track?.kind == 'audio')?.track; return t && t.id != old && t.readyState == 'live'; }, old), 'a live mic sent again');
  assert.deepStrictEqual(await a.evaluate(() => webRTCConfig.stream.getAudioTracks().map(t => t.readyState)), ['live'], 'one live mic track');
  assert.ok(await a.evaluate(() => webRTCConfig.stream.getAudioTracks()[0].getSettings().deviceId != __unplugged), 'another mic, not the unplugged one reopened');
  assert.ok(await a.evaluate(() => !!webRTCConfig.stream.getAudioTracks()[0].onended), 'the new mic is watched too');
  await waitFor(async () => (await liveRemoteAudio(b)) === 1, 'remote audio after the unplug');
});

test('with no mic left after an unplug, the next mic plugged in is used', async t => {
  const a = await open(t, 'alice', () => {
    const md = navigator.mediaDevices, enumerate = md.enumerateDevices.bind(md), gum = md.getUserMedia.bind(md);
    window.__noMics = false;
    md.enumerateDevices = async () => (await enumerate()).filter(d => !(__noMics && d.kind == 'audioinput'));
    md.getUserMedia = c => __noMics && c.audio ? Promise.reject(new DOMException('none', 'NotFoundError')) : gum(c);
  });
  await waitFor(() => a.evaluate(() => $('#micSelect').options.length > 1), 'mic list');
  await a.evaluate(() => { __noMics = true; const t = webRTCConfig.stream.getAudioTracks()[0]; t.stop(); t.dispatchEvent(new Event('ended')); });
  await waitFor(() => a.evaluate(() => $('#micSelect').options.length == 0), 'no mic listed');
  await a.evaluate(() => { __noMics = false; navigator.mediaDevices.dispatchEvent(new Event('devicechange')); }); // a mic plugged in
  await waitFor(() => a.evaluate(() => webRTCConfig.stream.getAudioTracks().map(t => t.readyState).join() == 'live'), 'live mic again');
});

test('name, mic and camera choice survive a reload of the tab, not a new tab', async t => {
  const a = await open(t, null);
  await a.fill('#nameInput', 'dora');
  await a.click('#joinBtn');
  await waitFor(() => a.evaluate(() => $('#micSelect').options.length > 1), 'mic list filled');
  const mic = await a.evaluate(() => [...document.querySelectorAll('#micSelect option')].find(o => o.value != webRTCConfig.stream.getAudioTracks()[0].getSettings().deviceId && o.value != 'default').value);
  await a.selectOption('#micSelect', mic);
  await waitFor(() => a.evaluate(m => webRTCConfig.stream.getAudioTracks()[0].getSettings().deviceId == m, mic), 'mic switched');
  await a.click('#addRemoveCameraBtn');
  await waitFor(() => a.evaluate(() => camActive), 'camera on');
  const cam = await a.evaluate(() => [...document.querySelectorAll('#cameraSelect option')].find(o => o.value != selectedCameraId).value);
  await a.selectOption('#cameraSelect', cam);
  await waitFor(() => a.evaluate(c => allUserStreams[MY_UUID].videostream?.getVideoTracks()[0].getSettings().deviceId == c, cam), 'camera switched');
  await a.goto(`${BASE}#roomname=${room(t)}x`); // other room, same tab: the page reloads itself
  await waitFor(() => a.evaluate(() => roomname.endsWith('x')).catch(() => false), 'reloaded into the other room');
  await waitFor(() => a.locator('#lobby').isVisible(), 'lobby shown');
  assert.strictEqual(await a.inputValue('#nameInput'), 'dora');
  assert.strictEqual(await a.evaluate(() => webRTCConfig.stream.getAudioTracks()[0].getSettings().deviceId), mic, 'mic kept');
  await waitFor(async () => (await a.inputValue('#lobbyMic')) === mic, 'lobby shows the mic');
  await waitFor(() => a.evaluate(c => allUserStreams[MY_UUID].videostream?.getVideoTracks()[0].getSettings().deviceId == c, cam), 'camera kept, and on as before');
  await waitFor(async () => (await a.inputValue('#lobbyCamera')) === cam, 'lobby shows the camera');
  const fresh = await a.context().newPage();
  await fresh.goto(`${BASE}#roomname=${room(t)}`);
  await waitFor(() => fresh.locator('#lobby').isVisible(), 'lobby shown');
  assert.strictEqual(await fresh.inputValue('#nameInput'), '', 'new tab starts empty');
});

test('lobby: quick device picks run one at a time, no second mic or camera leaks', async t => {
  const a = await open(t, 'alice', slowMedia);
  await waitFor(() => a.evaluate(() => $('#lobbyMic').options.length > 2), 'mic list');
  await a.evaluate(() => { // two picks before the first switch is done, like arrow keys on a focused dropdown
    const [, x, y] = [...$('#lobbyMic').options].map(o => o.value);
    for (const v of [x, y]) { $('#lobbyMic').value = v; $('#lobbyMic').dispatchEvent(new Event('change')); }
  });
  await a.selectOption('#lobbyCamera', await a.evaluate(() => $('#lobbyCamera').options[1].value));
  await waitFor(() => a.evaluate(() => camActive), 'camera on');
  await a.evaluate(() => { const [, x, y] = [...$('#lobbyCamera').options].map(o => o.value); for (const v of [y, x]) { $('#lobbyCamera').value = v; $('#lobbyCamera').dispatchEvent(new Event('change')); } });
  await mediaSettled(a);
  assert.deepStrictEqual(await a.evaluate(() => [webRTCConfig.stream.getAudioTracks().length, allUserStreams[MY_UUID].videostream.getVideoTracks().length]), [1, 1]);
  await waitFor(() => a.evaluate(() => $('#lobbyMic').value == webRTCConfig.stream.getAudioTracks()[0].getSettings().deviceId), 'dropdown shows the mic in use');
  await a.click('#joinBtn');
  assert.strictEqual(await a.evaluate(() => $('#lobbyVideo').srcObject), null, 'hidden preview let go after Join');
});

// Before camera permission, browsers list a camera as a placeholder: no label, deviceId "".
const noCamPermission = () => {
  const md = navigator.mediaDevices, enumerate = md.enumerateDevices.bind(md), gum = md.getUserMedia.bind(md);
  let granted = false;
  md.getUserMedia = async c => { const s = await gum(c); granted ||= !!c.video; return s; };
  md.enumerateDevices = async () => (await enumerate()).map(d => d.kind != 'videoinput' || granted ? d
    : { kind: d.kind, deviceId: '', label: '', groupId: '' }).filter((d, i, l) => d.deviceId || l.findIndex(e => e.kind == d.kind) == i);
};

test('lobby: the placeholder camera listed before permission turns the camera on', async t => {
  const a = await open(t, 'alice', noCamPermission);
  await waitFor(() => a.evaluate(() => $('#lobbyCamera').options.length == 2), 'one placeholder camera');
  await a.selectOption('#lobbyCamera', { index: 1 });
  await waitFor(() => a.evaluate(() => camActive && $('#lobbyVideo').checkVisibility()), 'camera on with preview');
  await waitFor(() => a.evaluate(() => $('#lobbyCamera').options.length == 3 && $('#lobbyCamera').value == allUserStreams[MY_UUID].videostream.getVideoTracks()[0].getSettings().deviceId), 'real cameras listed, the one in use picked');
});

test('lobby: a camera prompt answered with no goes back to Off', async t => {
  const a = await open(t, 'alice', () => {
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = c => c.video ? Promise.reject(new DOMException('denied', 'NotAllowedError')) : gum(c);
  });
  await waitFor(() => a.evaluate(() => $('#lobbyCamera').options.length > 1), 'camera listed');
  await a.selectOption('#lobbyCamera', { index: 1 });
  await waitFor(async () => await a.inputValue('#lobbyCamera') == 'off', 'dropdown back to Off');
});

// camOnAtStart turns the camera on 1s after the mic is ready, just before the lobby shows: wait until that is done.
const pastCamOnAtStart = async page => {
  await page.evaluate(() => new Promise(r => setTimeout(r, 1000))); // set after the page's own timer: fires after it
  await waitFor(() => page.evaluate(() => !mediaBusy), 'camera settled');
};

test('lobby: a camera picked right away is not switched off by the saved camera state', async t => {
  const a = await open(t, null, () => sessionStorage.camOn ||= '1'); // camera was on last time in this tab
  await waitFor(() => a.locator('#lobby').isVisible(), 'lobby');
  await a.selectOption('#lobbyCamera', await a.evaluate(() => [...$('#lobbyCamera').options].at(-1).value)); // within camOnAtStart's first second
  await pastCamOnAtStart(a);
  assert.ok(await a.evaluate(() => camActive), 'camera still on');
});

test('a camera that ended is not turned on again after a reload', async t => {
  const a = await open(t, null);
  await waitFor(() => a.locator('#lobby').isVisible(), 'lobby');
  await a.selectOption('#lobbyCamera', await a.evaluate(() => [...$('#lobbyCamera').options].at(-1).value));
  await waitFor(() => a.evaluate(() => camActive), 'camera on');
  await a.evaluate(() => allUserStreams[MY_UUID].videostream.getVideoTracks()[0].dispatchEvent(new Event('ended'))); // unplugged
  await waitFor(() => a.evaluate(() => !camActive), 'camera off');
  await a.reload();
  await waitFor(() => a.locator('#lobby').isVisible(), 'lobby');
  await pastCamOnAtStart(a);
  assert.strictEqual(await a.evaluate(() => camActive), false);
});

test('a denied mic is asked for once, also with a saved mic', async t => {
  const a = await open(t, 'alice', () => {
    sessionStorage.mic = 'some-saved-mic';
    window.__asked = 0;
    navigator.mediaDevices.getUserMedia = () => (__asked++, Promise.reject(new DOMException('denied', 'NotAllowedError')));
  });
  await waitFor(() => a.locator('#micError').isVisible(), 'message shown');
  assert.strictEqual(await a.evaluate(() => __asked), 1);
});

test('closed room: anyone locks, a newcomer knocks, any member lets in or denies', async t => {
  const [a, b] = await call(t);
  await b.click('#moreBtn'); await b.click('#lockBtn');
  await waitFor(() => a.evaluate(() => $('#chatText').textContent.includes('bob locked the room')), 'alice told');
  assert.match(await a.textContent('#lockBtn'), /Unlock room/);
  const knock = async name => {
    const p = await join(t, name);
    await waitFor(async () => /let you in/.test(await p.textContent('#lobbyMsg')), `${name} waits at the door`);
    return p;
  };
  const c = await knock('carol');
  await waitFor(() => a.locator('.knock', { hasText: 'carol wants to join' }).isVisible(), 'request shown to alice');
  await b.locator('.knock', { hasText: 'carol' }).getByText('Deny').click();
  await waitFor(async () => /ask again in 1[0-5]s/.test(await c.textContent('#lobbyMsg')), 'carol denied with a cooldown');
  assert.ok(await c.isDisabled('#joinBtn'), 'no knocking during the cooldown');
  await waitFor(async () => /ask again in 1[0-4]s/.test(await c.textContent('#lobbyMsg')), 'the cooldown counts down');
  await waitFor(async () => !(await a.locator('.knock').count()), 'request gone on alice');
  assert.strictEqual(await connectedPeers(c), 0, 'carol stayed out');
  const d = await knock('dave');
  await a.locator('.knock', { hasText: 'dave' }).getByText('Let in').click();
  await waitFor(async () => (await connectedPeers(d)) === 2, 'dave connected to both');
  assert.strictEqual(await d.locator('#lobby').isVisible(), false);
  assert.match(await d.textContent('#lockBtn'), /Unlock room/, 'dave sees the lock');
});

test('the lock message uses the name from the server while the peer is still unnamed', async t => {
  const a = await join(t, 'alice');
  await a.evaluate(() => socket.listeners('locked')[0]({ locked: true, by: 'x', name: 'zed' }));
  assert.match(await a.textContent('#chatText'), /zed locked the room/);
  await a.evaluate(() => socket.listeners('locked')[0]({ locked: false, by: 'x', name: 'NA' }));
  assert.match(await a.textContent('#chatText'), /Someone unlocked the room/);
});

test('the first one in the lobby can open the room closed', async t => {
  const a = await open(t, 'alice');
  await waitFor(() => a.locator('#closedInput').isVisible(), 'choice shown to the first one');
  await a.check('#closedInput');
  await a.click('#joinBtn');
  await waitFor(async () => /Unlock room/.test(await a.textContent('#lockBtn')), 'room closed');
  const b = await open(t, 'bob');
  await b.waitForFunction(() => !$('#lobby').hidden);
  await serverSync(b); // the lobby's own ask is answered by now
  assert.strictEqual(await b.locator('#closedInput').isVisible(), false, 'not offered when someone is in');
  await b.click('#joinBtn');
  await waitFor(async () => /let you in/.test(await b.textContent('#lobbyMsg')), 'bob knocks');
});

test('a closed pick from a lobby someone joined meanwhile: told the room is open, no pick at the door', async t => {
  const a = await open(t, 'alice'), c = await open(t, 'carol');
  for (const p of [a, c]) await waitFor(() => p.locator('#closedInput').isVisible(), 'room empty: choice shown');
  const b = await join(t, 'bob'); // open
  await waitFor(async () => /Lock room/.test(await b.textContent('#lockBtn')), 'bob in');
  await a.check('#closedInput');
  await a.click('#joinBtn');
  await waitFor(() => a.evaluate(() => $('#chatText').textContent.includes('the room is open')), 'alice told');
  assert.match(await a.textContent('#lockBtn'), /Lock room/);
  assert.strictEqual(await a.isChecked('#closedInput'), false, 'pick cleared after joining');
  const d = await open(t, 'dave'); // a hidden pick that is still ticked (Firefox restores it on reload) counts for nothing
  await d.waitForFunction(() => !$('#lobby').hidden);
  await serverSync(d);
  await d.evaluate(() => $('#closedInput').checked = true);
  await d.click('#joinBtn');
  await d.waitForFunction(() => $('#lobby').hidden);
  assert.ok(!(await d.textContent('#chatText')).includes('the room is open'), 'no message about a pick dave never saw');
  await b.click('#moreBtn'); await b.click('#lockBtn');
  await waitFor(async () => /Unlock room/.test(await a.textContent('#lockBtn')), 'locked');
  await c.check('#closedInput');
  await c.click('#joinBtn');
  await waitFor(async () => /let you in/.test(await c.textContent('#lobbyMsg')), 'carol knocks');
  assert.strictEqual(await c.locator('#closedInput').isVisible(), false, 'no open/closed pick at a locked door');
});

test('knock banners work for any knocker UUID, also one that spells an element id', async t => {
  const a = await join(t, 'alice');
  await waitFor(() => a.evaluate(() => allUserStreams[MY_UUID].status === ''), 'joined'); // the join ack clears #knocks; the lobby already hides on Join
  await a.evaluate(() => ['s', 'x'].forEach(UUID => socket.listeners('knock')[0]({ UUID, name: UUID }))); // "knock" + "s" == "knocks"
  assert.strictEqual(await a.locator('.knock').count(), 2);
  await a.evaluate(() => socket.listeners('knockDone')[0]('s'));
  assert.deepStrictEqual(await a.locator('.knock').allTextContents(), ['x wants to joinLet inDeny']);
  assert.deepStrictEqual(await a.evaluate(() => Object.keys(knockRows)), ['x'], 'answered knocks are forgotten: knock-and-leave loops do not grow the map');
});

test('a full room tells the next one so in the lobby (#29)', async t => {
  const e = await open(t, 'eve');
  await e.evaluate(async () => { // four others take the seats
    for (let i = 0; i < 4; i++) {
      const s = io({ forceNew: true });
      await s.emitWithAck('registerUUID', { UUID: crypto.randomUUID(), UUID_KEY: 'k' });
      await s.emitWithAck('joinRoom', { roomname });
    }
  });
  await e.click('#joinBtn');
  await waitFor(async () => /full/.test(await e.textContent('#lobbyMsg')), 'eve told the room is full');
  assert.ok(await e.isEnabled('#joinBtn'), 'she can try again');
});

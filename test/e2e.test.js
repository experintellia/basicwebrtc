// End-to-end: real server + headless Chromium with fake cam/mic.
// Run: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright-core');

const PORT = 3100 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}/`;
let browser;

before(async () => {
  process.env.listen_port = String(PORT);
  process.env.listen_ip = '127.0.0.1';
  require('../server.js'); // ponytail: in-process, runner exits via --test-force-exit
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

// Page in the lobby, not joined yet.
async function open(room, name, initScript, file = '') {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  if (initScript) await page.addInitScript(initScript);
  page.on('pageerror', e => console.log(`[${name}] pageerror`, e.message));
  await page.goto(`${BASE}${file}#roomname=${room}&username=${encodeURIComponent(name)}`);
  return page;
}

async function join(...args) {
  const page = await open(...args);
  await page.click('#joinBtn'); // lobby: sound and camera check first
  return page;
}

// Number of remote peers whose ICE is connected, as seen from `page`.
const connectedPeers = page => page.evaluate(() =>
  Object.values(pcs).filter(p => p.isConnected).length);

// Number of remote <audio> elements actually receiving a live track.
const liveRemoteAudio = page => page.evaluate(() =>
  [...document.querySelectorAll('#audioStreams audio')]
    .filter(a => a.srcObject && a.srcObject.getAudioTracks().some(t => t.readyState === 'live' && !t.muted)).length);

// Init script: keeps the raw RTCPeerConnections in window.__raw.
const trackPcs = () => { const O = RTCPeerConnection; window.__raw = []; window.RTCPeerConnection = function (c) { const p = new O(c); __raw.push(p); return p; }; };

async function waitFor(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    if ((last = await fn())) return last;
    await new Promise(r => setTimeout(r, 250));
  }
  assert.fail(`timed out waiting for ${what} (last=${last})`);
}

test('peers connect when the page is opened as index.html', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice', null, 'index.html');
  const b = await join(room, 'bob', null, 'index.html');
  await waitFor(async () => (await connectedPeers(b)) === 1, 'ICE connected');
  await a.context().close(); await b.context().close();
});

test('two peers connect and exchange audio', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice');
  const b = await join(room, 'bob');
  await waitFor(async () => (await connectedPeers(a)) === 1 && (await connectedPeers(b)) === 1, 'ICE connected');
  await waitFor(async () => (await liveRemoteAudio(a)) === 1 && (await liveRemoteAudio(b)) === 1, 'remote audio');
  await a.context().close(); await b.context().close();
});

// Status text on a remote peer's tile ("" when connected).
const peerStatus = page => page.evaluate(() =>
  [...document.querySelectorAll('#mediaDiv .peerStatus')].filter(e => e.parentElement.id != MY_UUID).map(e => e.textContent).join('|'));
const selfStatus = page => page.evaluate(() => byId(MY_UUID)?.querySelector('.peerStatus')?.textContent);

test('own tile shows "connecting…" until joined and "reconnecting…" while the server is gone', async () => {
  const ctx = await browser.newContext();
  await ctx.route('**/socket.io/**', r => r.abort()); // server unreachable
  const a = await ctx.newPage();
  await a.goto(`${BASE}#roomname=r${Date.now()}&username=alice`);
  assert.strictEqual(await selfStatus(a), '', 'nothing while in the lobby');
  await a.click('#joinBtn');
  await waitFor(async () => (await selfStatus(a)) === 'connecting…', 'connecting shown');
  await ctx.unroute('**/socket.io/**');
  await waitFor(async () => (await selfStatus(a)) === '', 'status cleared after join');
  await a.evaluate(() => socket.disconnect());
  await waitFor(async () => (await selfStatus(a)) === 'reconnecting…', 'reconnecting shown');
  await a.evaluate(() => socket.connect());
  await waitFor(async () => (await selfStatus(a)) === '', 'status cleared after rejoin');
  await ctx.close();
});

test('peer tile shows "connecting" until ICE is up, then nothing', async () => {
  const room = 'r' + Date.now();
  const noIce = () => { RTCPeerConnection.prototype.addIceCandidate = async () => { }; }; // ICE can never connect
  const a = await join(room, 'alice', noIce);
  const b = await join(room, 'bob', noIce);
  await waitFor(async () => (await peerStatus(a)) === 'connecting…' && (await peerStatus(b)) === 'connecting…', 'connecting shown');
  await new Promise(r => setTimeout(r, 2000)); // ICE on localhost would be up by now
  assert.strictEqual(await connectedPeers(a) + await connectedPeers(b), 0, 'stub kept ICE down');
  assert.strictEqual(await peerStatus(a) + await peerStatus(b), 'connecting…connecting…');
  await a.context().close(); await b.context().close();
  const c = await join(room + 'x', 'alice');
  const d = await join(room + 'x', 'bob');
  await waitFor(async () => (await connectedPeers(c)) === 1 && (await connectedPeers(d)) === 1, 'ICE connected');
  await waitFor(async () => (await peerStatus(c)) === '' && (await peerStatus(d)) === '', 'status cleared');
  await c.context().close(); await d.context().close();
});

test('camera toggle reaches the other peer', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice');
  const b = await join(room, 'bob');
  await waitFor(async () => (await connectedPeers(b)) === 1, 'ICE connected');
  await a.click('#addRemoveCameraBtn');
  await waitFor(() => remoteVideoShown(b), 'remote video on bob');
  await a.context().close(); await b.context().close();
});

// #3: bob turns on his camera after answering alice's offer, but before alice has applied that
// answer. His "renegotiate" then arrives while alice is still making an offer and must not be lost.
test('answerer camera change during an in-flight offer reaches the initiator', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice'); // already in the room -> initiator
  const b = await join(room, 'bob');
  await waitFor(async () => (await connectedPeers(b)) === 1, 'ICE connected');
  await a.evaluate(() => { // hold back bob's answers on alice for 3s
    const pc = Object.values(pcs)[0], orig = pc.signaling;
    pc.signaling = d => d && d.type == 'answer' ? new Promise(r => setTimeout(r, 3000)).then(() => orig(d)) : orig(d);
  });
  await b.evaluate(() => { // count offers bob has answered
    const pc = Object.values(pcs)[0], orig = pc.signaling;
    window.__answered = 0;
    pc.signaling = d => orig(d).then(() => { if (d && d.type == 'offer') __answered++; });
  });
  await a.click('#addRemoveCameraBtn');
  await waitFor(() => b.evaluate(() => __answered > 0), 'bob answered alice\'s offer', 3000);
  await b.click('#addRemoveCameraBtn'); // after bob answered, before alice applied the answer
  await waitFor(() => remoteVideoShown(b), 'remote video on bob');
  await waitFor(() => remoteVideoShown(a), 'remote video on alice');
  await a.context().close(); await b.context().close();
});

// #25: one lost answer must not block all later renegotiation.
test('a lost answer does not block later camera changes', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice');
  const b = await join(room, 'bob');
  await waitFor(async () => (await connectedPeers(b)) === 1, 'ICE connected');
  await a.evaluate(() => { // drop exactly one answer on alice
    const pc = Object.values(pcs)[0], orig = pc.signaling;
    let dropped = false;
    pc.signaling = d => d && d.type == 'answer' && !dropped ? (dropped = true, Promise.resolve()) : orig(d);
  });
  await a.click('#addRemoveCameraBtn');
  await b.click('#addRemoveCameraBtn');
  await waitFor(() => remoteVideoShown(b), 'remote video on bob');
  await waitFor(() => remoteVideoShown(a), 'remote video on alice');
  await a.context().close(); await b.context().close();
});

// Mid-deploy: an older answerer doesn't echo gen; its answers must still be applied.
test('answers without gen (older client) are still accepted', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice');
  const b = await join(room, 'bob');
  await waitFor(async () => (await connectedPeers(b)) === 1, 'ICE connected');
  await a.evaluate(() => { // strip gen from every answer alice receives
    const pc = Object.values(pcs)[0], orig = pc.signaling;
    pc.signaling = d => orig(d && d.type == 'answer' ? { type: d.type, sdp: d.sdp } : d);
  });
  await a.click('#addRemoveCameraBtn');
  await waitFor(() => remoteVideoShown(b), 'remote video on bob');
  assert.strictEqual(await a.evaluate(() => Object.values(pcs)[0].makingOffer), false, 'answer applied');
  await a.context().close(); await b.context().close();
});

// #6: bob's socket reconnects; alice's old pc still sends an offer to bob before alice rebuilds it.
test('stale offer from the old connection after a fast reconnect', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice');
  const b = await join(room, 'bob');
  await waitFor(async () => (await connectedPeers(b)) === 1, 'ICE connected');
  await a.evaluate(() => {
    window.__oldPc = Object.values(pcs)[0];
    socket.off('userJoined');
    socket.on('userJoined', c => { __oldPc.signaling('renegotiate'); setTimeout(() => createRemoteSocket(true, c.UUID), 1500); });
  });
  await b.evaluate(() => socket.io.engine.close());
  await waitFor(() => a.evaluate(() => Object.values(pcs)[0] !== __oldPc), 'alice rebuilt the pc');
  for (const p of [a, b]) await waitFor(async () => (await connectedPeers(p)) === 1 && (await liveRemoteAudio(p)) === 1, 'ICE and audio');
  await a.context().close(); await b.context().close();
});

test('camera picker switches the camera sent to the other peer', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice');
  const b = await join(room, 'bob');
  await waitFor(async () => (await connectedPeers(b)) === 1, 'ICE connected');
  await a.click('#addRemoveCameraBtn');
  await waitFor(() => remoteVideoShown(b), 'remote video on bob');
  await waitFor(() => a.locator('#selectCameraBtn').isVisible(), 'picker visible');
  const camId = () => a.evaluate(() => allUserStreams[MY_UUID].videostream.getVideoTracks()[0].getSettings().deviceId);
  const other = await a.evaluate(cur => [...document.querySelectorAll('#cameraSelect option')].find(o => o.value != cur).value, await camId());
  await a.selectOption('#cameraSelect', other);
  await waitFor(async () => (await camId()) === other, 'camera switched');
  await waitFor(() => remoteVideoShown(b), 'remote video after switch');
  await a.context().close(); await b.context().close();
});

test('screen share reaches the other peer', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice');
  const b = await join(room, 'bob');
  await waitFor(async () => (await connectedPeers(b)) === 1, 'ICE connected');
  await a.click('#addRemoveScreenBtn');
  await waitFor(() => a.evaluate(() => screenActive), 'screen capture started');
  await waitFor(() => remoteVideoShown(b), 'remote screen on bob');
  await a.context().close(); await b.context().close();
});

// #13: Detail (default) / Performance mode for screen share, applied live without renegotiation.
const screenMode = page => page.evaluate(() => {
  const track = allUserStreams[MY_UUID].videostream.getVideoTracks()[0];
  const senders = __raw.flatMap(p => p.getSenders().filter(s => s.track === track));
  return [track.contentHint, ...senders.map(s => s.getParameters().degradationPreference)];
});

test('screen share mode: detail by default, performance via dropdown, applied to late joiners', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice', trackPcs);
  const b = await join(room, 'bob');
  await waitFor(async () => (await connectedPeers(b)) === 1, 'ICE connected');
  assert.strictEqual(await a.locator('#selectScreenModeBtn').isVisible(), false, 'hidden without screen share');
  await a.click('#addRemoveCameraBtn');
  await waitFor(() => remoteVideoShown(b), 'remote video on bob');
  assert.strictEqual(await a.locator('#selectScreenModeBtn').isVisible(), false, 'hidden for camera');
  await a.click('#addRemoveScreenBtn');
  await waitFor(() => a.evaluate(() => screenActive), 'screen capture started');
  await waitFor(() => remoteVideoShown(b), 'remote screen on bob');
  assert.ok(await a.locator('#selectScreenModeBtn').isVisible(), 'dropdown shown while sharing');
  await waitFor(async () => (await screenMode(a)).join() === 'detail,maintain-resolution', 'detail mode');
  const offers = () => b.evaluate(() => window.__offers);
  await b.evaluate(() => { const pc = Object.values(pcs)[0], orig = pc.signaling; window.__offers = 0; pc.signaling = d => { if (d && d.type == 'offer') __offers++; return orig(d); }; });
  await a.selectOption('#screenModeSelect', 'motion');
  await waitFor(async () => (await screenMode(a)).join() === 'motion,maintain-framerate', 'performance mode');
  await a.selectOption('#screenModeSelect', 'detail');
  await waitFor(async () => (await screenMode(a)).join() === 'detail,maintain-resolution', 'back to detail');
  await a.selectOption('#screenModeSelect', 'motion');
  await waitFor(async () => (await screenMode(a)).join() === 'motion,maintain-framerate', 'performance mode again');
  const frames = () => b.evaluate(() => [...document.querySelectorAll('#mediaDiv video')].map(v => v.getVideoPlaybackQuality().totalVideoFrames).reduce((x, y) => x + y, 0));
  const before = await frames();
  await waitFor(async () => (await frames()) > before, 'remote video keeps playing');
  assert.strictEqual(await offers(), 0, 'no renegotiation');
  const c = await join(room, 'carol');
  await waitFor(() => remoteVideoShown(c), 'remote screen on carol');
  await waitFor(async () => (await screenMode(a)).join() === 'motion,maintain-framerate,maintain-framerate', 'late joiner gets mode');
  await a.click('#addRemoveScreenBtn');
  await waitFor(async () => !(await a.locator('#selectScreenModeBtn').isVisible()), 'hidden after share ends');
  await a.click('#addRemoveCameraBtn');
  await waitFor(() => a.evaluate(() => camActive), 'camera on');
  await a.evaluate(() => { const s = document.getElementById('screenModeSelect'); s.value = 'detail'; s.dispatchEvent(new Event('change')); }); // e.g. a popup left open
  assert.strictEqual(await a.evaluate(() => allUserStreams[MY_UUID].videostream.getVideoTracks()[0].contentHint), '', 'camera track untouched');
  for (const p of [a, b, c]) await p.context().close();
});

test('browser "Stop sharing" ends the screen share', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice');
  const b = await join(room, 'bob');
  await waitFor(async () => (await connectedPeers(b)) === 1, 'ICE connected');
  await a.click('#addRemoveScreenBtn');
  await waitFor(() => remoteVideoShown(b), 'remote screen on bob');
  // Chrome's "Stop sharing" bar ends the track; stop() alone doesn't fire 'ended'.
  await a.evaluate(() => allUserStreams[MY_UUID].videostream.getVideoTracks()[0].dispatchEvent(new Event('ended')));
  await waitFor(async () => !(await a.evaluate(() => screenActive)), 'screen share stopped');
  await waitFor(async () => !(await remoteVideoShown(b)), 'remote screen gone on bob');
  await a.context().close(); await b.context().close();
});

test('camera turned on before the peer connects', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice');
  const errors = [];
  a.on('pageerror', e => errors.push(e.message));
  await waitFor(() => a.evaluate(() => !!allUserStreams[MY_UUID]), 'mic ready');
  // Start the camera right after the pc is created, before ICE connects.
  await a.evaluate(async () => {
    const cam = await navigator.mediaDevices.getUserMedia({ video: true });
    socket.once('userJoined', () => { camActive = true; startVideo(cam, $('#addRemoveCameraBtn')); });
  });
  const b = await join(room, 'bob', trackPcs);
  await waitFor(() => remoteVideoShown(b), 'remote video on bob');
  await new Promise(r => setTimeout(r, 1000));
  assert.deepStrictEqual(errors, []);
  // Non-initiator side: bob's camera is already on when his pc is (re)created.
  await b.click('#addRemoveCameraBtn');
  await waitFor(() => remoteVideoShown(a), 'remote video on alice');
  await a.evaluate(() => window.__oldPc = Object.values(pcs)[0]);
  await b.evaluate(() => { __raw[0].close(); socket.io.engine.close(); }); // bob's connection dies, his socket reconnects
  await waitFor(() => a.evaluate(() => Object.values(pcs)[0] && Object.values(pcs)[0] !== __oldPc), 'alice rebuilt the pc');
  await waitFor(() => remoteVideoShown(a), 'remote video on alice after reconnect');
  await a.context().close(); await b.context().close();
});

test('third peer joins a running call', async () => {
  const room = 'r' + Date.now();
  const pages = [await join(room, 'alice'), await join(room, 'bob')];
  await waitFor(async () => (await connectedPeers(pages[1])) === 1, 'first pair');
  pages.push(await join(room, 'carol'));
  for (const p of pages) await waitFor(async () => (await connectedPeers(p)) === 2, 'full mesh');
  for (const p of pages) await p.context().close();
});

test('peer leaves: the other side cleans up', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice');
  const b = await join(room, 'bob');
  await waitFor(async () => (await liveRemoteAudio(a)) === 1, 'remote audio');
  await b.context().close();
  await waitFor(async () => (await a.locator('#audioStreams audio').count()) === 0, 'audio element removed');
  await a.context().close();
});

test('signaling socket reconnect keeps the call working', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice');
  const b = await join(room, 'bob');
  await waitFor(async () => (await connectedPeers(b)) === 1, 'ICE connected');
  await waitFor(() => b.evaluate(() => Object.values(pcs)[0].send({})), 'data channel open');
  for (const p of [a, b]) await p.evaluate(() => window.__pc = Object.values(pcs)[0]);
  // Simulate a network blip / proxy idle timeout on alice's signaling socket.
  await a.evaluate(() => socket.io.engine.close());
  await waitFor(() => a.evaluate(() => socket.connected), 'socket reconnected');
  await new Promise(r => setTimeout(r, 1000));
  assert.strictEqual(await a.evaluate(() => socket.listeners('signaling').length), 1, 'signaling handler registered once');
  // A chat line sent once must arrive once.
  await b.click('#moreBtn'); await b.click('#addRemoveChatBtn');
  await b.fill('#chatInputText', 'ping');
  await b.press('#chatInputText', 'Enter');
  await waitFor(() => a.locator('#chatText div', { hasText: 'ping' }).count(), 'chat on alice');
  await new Promise(r => setTimeout(r, 500));
  assert.strictEqual(await a.locator('#chatText div', { hasText: 'ping' }).count(), 1, 'chat delivered once');
  // After the blip alice must still be able to renegotiate (turn on cam) and chat.
  await a.click('#addRemoveCameraBtn');
  await waitFor(() => remoteVideoShown(b), 'remote video after reconnect');
  for (const p of [a, b]) {
    await waitFor(async () => (await connectedPeers(p)) === 1 && (await liveRemoteAudio(p)) === 1, 'one live peer each');
    assert.strictEqual(await p.evaluate(() => Object.keys(pcs).length), 1, 'no stale peer connections');
    assert.ok(await p.evaluate(() => Object.values(pcs)[0] === __pc), 'working pc not replaced');
  }
  await a.context().close(); await b.context().close();
});

const remoteVideoShown = page => page.evaluate(() => [...document.querySelectorAll('#mediaDiv video')]
  .some(v => v.srcObject && v.videoWidth > 0 && !v.style.transform.includes('scaleX')));

test('chat shows messages as text and keeps links clickable', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice');
  const b = await join(room, 'bob');
  await waitFor(async () => (await connectedPeers(b)) === 1, 'ICE connected');
  const msg = `<img src=x onerror="window.__xss=1"> it's "ok" https://example.com/a?b=1`;
  await a.click('#moreBtn'); await a.click('#addRemoveChatBtn');
  await a.fill('#chatInputText', msg);
  await a.press('#chatInputText', 'Enter');
  await waitFor(() => b.evaluate(() => document.querySelector('#chatText').textContent.includes('example.com')), 'message on bob');
  await new Promise(r => setTimeout(r, 300));
  assert.strictEqual(await b.evaluate(() => window.__xss), undefined, 'no script execution');
  assert.strictEqual(await b.evaluate(() => document.querySelector('#chatText div:last-child').textContent), 'alice: ' + msg);
  assert.strictEqual(await b.evaluate(() => document.querySelector('#chatText div:last-child .chatName').textContent), 'alice', 'sender name styled apart');
  assert.strictEqual(await b.evaluate(() => document.querySelector('#chatText a').href), 'https://example.com/a?b=1');
  assert.strictEqual(await a.inputValue('#chatInputText'), '', 'input cleared');
  await a.context().close(); await b.context().close();
});

test('quote-free chat payload does not execute (bypasses old server escaping)', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice');
  const b = await join(room, 'bob');
  await waitFor(async () => (await connectedPeers(b)) === 1, 'ICE connected');
  // No ' " \\ $ chars, so the upstream server's escaping leaves it intact.
  const payload = '<img src=x onerror=window.__xss=1>';
  await a.click('#moreBtn'); await a.click('#addRemoveChatBtn');
  await a.fill('#chatInputText', payload);
  await a.press('#chatInputText', 'Enter');
  await waitFor(() => b.evaluate(() => document.querySelectorAll('#chatText > div').length > 0), 'message on bob');
  await new Promise(r => setTimeout(r, 400)); // give any injected onerror time to fire
  assert.strictEqual(await b.evaluate(() => window.__xss), undefined, 'no script execution');
  assert.strictEqual(await a.evaluate(() => window.__xss), undefined, 'no self-execution');
  assert.strictEqual(await b.evaluate(() => document.querySelector('#chatText div:last-child').textContent), 'alice: ' + payload);
  await a.context().close(); await b.context().close();
});

test('remote username is shown as text', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, '<img src=x onerror=window.__xss=1>');
  const b = await join(room, 'bob');
  await waitFor(async () => (await connectedPeers(b)) === 1, 'ICE connected');
  await a.click('#addRemoveCameraBtn');
  await waitFor(() => remoteVideoShown(b), 'remote video on bob');
  await new Promise(r => setTimeout(r, 300));
  assert.strictEqual(await b.evaluate(() => window.__xss), undefined, 'no script execution');
  assert.ok(await b.evaluate(() => document.querySelector('#mediaDiv').textContent.includes('<img src=x')), 'name shown literally');
  await a.context().close(); await b.context().close();
});

test('chat, mute state and username reach the peer without the server (#11)', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice');
  const b = await join(room, 'bob');
  await waitFor(async () => (await connectedPeers(a)) === 1 && (await connectedPeers(b)) === 1, 'ICE connected');
  await a.evaluate(() => { socket.emit = () => { }; }); // alice can no longer reach the server
  await a.click('#moreBtn'); await a.click('#addRemoveChatBtn');
  await a.fill('#chatInputText', 'hi via p2p');
  await a.press('#chatInputText', 'Enter');
  await waitFor(() => b.evaluate(() => document.querySelector('#chatText').textContent == 'alice: hi via p2p'), 'chat on bob');
  assert.strictEqual(await a.evaluate(() => document.querySelector('#chatText').textContent), 'alice: hi via p2p', 'shown locally');
  await a.click('#muteUnmuteMicBtn');
  await waitFor(() => b.locator('.audioMuted').count(), 'mute icon on bob');
  await waitFor(() => b.evaluate(() => document.querySelector('#mediaDiv').textContent.includes('AL')), 'alice\'s initials on bob');
  const errors = [];
  a.on('pageerror', e => errors.push(e.message));
  await b.evaluate(() => { const pc = Object.values(pcs)[0]; pc.send(null); pc.send(5); pc.send({ username: 'x'.repeat(500), chat: 'long' + 'y'.repeat(5000) }); }); // a peer can send anything
  await waitFor(() => a.evaluate(() => document.querySelector('#chatText').textContent.includes('long')), 'chat on alice');
  assert.ok(await a.evaluate(() => Object.values(allUserStreams).every(u => u.username.length <= 64)), 'username capped');
  assert.ok(await a.evaluate(() => document.querySelector('#chatText div:last-child').textContent.length <= 2100), 'chat capped');
  assert.deepStrictEqual(errors, []);
  await a.context().close(); await b.context().close();
});

test('camera changes renegotiate without the server (#11)', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice');
  const b = await join(room, 'bob');
  await waitFor(async () => (await connectedPeers(a)) === 1 && (await connectedPeers(b)) === 1, 'ICE connected');
  await waitFor(() => b.evaluate(() => Object.values(pcs)[0].send({})), 'data channel open');
  for (const p of [a, b]) await p.evaluate(() => socket.disconnect());
  await a.click('#addRemoveCameraBtn'); // initiator: offer over the data channel
  await waitFor(() => remoteVideoShown(b), 'remote video on bob');
  await b.click('#addRemoveCameraBtn'); // answerer: "transceive"/"renegotiate" over the data channel
  await waitFor(() => remoteVideoShown(a), 'remote video on alice');
  await a.context().close(); await b.context().close();
});

test('call survives the signaling server going away and coming back (#11)', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice');
  const b = await join(room, 'bob');
  await waitFor(async () => (await liveRemoteAudio(a)) === 1 && (await liveRemoteAudio(b)) === 1, 'remote audio');
  await waitFor(() => b.evaluate(() => Object.values(pcs)[0].send({})), 'data channel open');
  for (const p of [a, b]) await p.evaluate(() => window.__pc = Object.values(pcs)[0]);
  await b.evaluate(() => socket.on('userJoined', () => window.__rejoined = true)); // runs after the app's handler
  await a.evaluate(() => socket.disconnect()); // server tells bob "userDiscconected"
  await waitFor(() => b.evaluate(() => __pc.left), 'bob saw alice leave the server');
  for (const p of [a, b]) {
    assert.strictEqual(await liveRemoteAudio(p), 1, 'audio still live');
    assert.strictEqual(await p.locator('#mediaDiv .videoplaceholder').count(), 2, 'no tile removed');
  }
  await a.click('#moreBtn'); await a.click('#addRemoveChatBtn');
  await a.fill('#chatInputText', 'still here');
  await a.press('#chatInputText', 'Enter');
  await waitFor(() => b.evaluate(() => document.querySelector('#chatText').textContent.includes('still here')), 'chat while server is gone');
  await a.evaluate(() => socket.connect()); // rejoin: bob gets "userJoined" for alice's UUID
  await waitFor(() => b.evaluate(() => window.__rejoined), 'bob handled alice\'s rejoin');
  for (const p of [a, b]) {
    assert.ok(await p.evaluate(() => Object.keys(pcs).length == 1 && Object.values(pcs)[0] === __pc), 'same peer connection kept');
    assert.strictEqual(await liveRemoteAudio(p), 1, 'audio live after rejoin');
  }
  await a.context().close(); await b.context().close();
});

// Each side has exactly one peer, its ICE is up now, and its audio is live.
const callUp = async p => (await p.evaluate(() => Object.values(pcs).length == 1 && Object.values(pcs)[0].iceUp())) && (await liveRemoteAudio(p)) === 1;

test('network switch: ICE and socket lost together, the call comes back', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice', trackPcs);
  const b = await join(room, 'bob');
  await waitFor(async () => (await callUp(a)) && (await callUp(b)), 'call up');
  for (const p of [a, b]) await p.evaluate(() => Object.values(pcs)[0].mappedEvents.close = []); // a lost network sends no goodbye
  await a.evaluate(() => { __raw[0].close(); socket.io.engine.close(); }); // old network gone: no ICE, socket drops and reconnects
  for (const p of [a, b]) await waitFor(() => callUp(p), 'call up again', 30000);
  await a.context().close(); await b.context().close();
});

test('rejoining peer that still has the call gets a reset when the other side rebuilds', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice');
  const b = await join(room, 'bob');
  await waitFor(async () => (await callUp(a)) && (await callUp(b)), 'call up');
  for (const p of [a, b]) await p.evaluate(() => window.__pc = Object.values(pcs)[0]);
  await b.evaluate(() => __pc.iceUp = () => false); // bob's side of the call is dead, alice's looks fine
  await a.evaluate(() => __pc.mappedEvents.close = []); // no close event reaches alice either
  await a.evaluate(() => socket.io.engine.close()); // alice rejoins, keeping bob
  for (const p of [a, b]) await waitFor(async () => (await p.evaluate(() => Object.values(pcs)[0] !== __pc)) && (await callUp(p)), 'new call on both sides');
  await a.context().close(); await b.context().close();
});

test('signaling uses the socket while it is up, even if the data channel reads open', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice');
  const b = await join(room, 'bob');
  await waitFor(async () => (await callUp(a)) && (await callUp(b)), 'call up');
  await waitFor(() => b.evaluate(() => Object.values(pcs)[0].send({})), 'data channel open');
  await b.evaluate(() => { const pc = Object.values(pcs)[0], send = pc.send; pc.send = m => m.signaling ? true : send(m); }); // one-way outage: bob's sends get lost
  await a.click('#addRemoveCameraBtn');
  await b.click('#addRemoveCameraBtn');
  await waitFor(async () => (await remoteVideoShown(a)) && (await remoteVideoShown(b)), 'video both ways');
  await a.context().close(); await b.context().close();
});

// Both sockets blip: bob sees alice leave, then is offline himself while she rejoins. His view must resync on rejoin.
test('stale "left the server" mark is cleared when rejoining a room the peer is in', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice');
  const b = await join(room, 'bob');
  await waitFor(async () => (await callUp(a)) && (await callUp(b)), 'call up');
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
  await a.context().close(); await b.context().close();
});

test('peer that crashed while we were off the server is removed after we rejoin', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice');
  const b = await join(room, 'bob');
  await waitFor(async () => (await callUp(a)) && (await callUp(b)), 'call up');
  await a.evaluate(() => socket.disconnect());
  (await b.context().newCDPSession(b)).send('Page.crash').catch(() => { }); // never resolves: the renderer is gone
  await a.evaluate(() => socket.connect());
  await waitFor(async () => (await a.locator('#mediaDiv .videoplaceholder').count()) === 1, 'tile removed', 30000);
  await a.context().close(); await b.context().close();
});

test('crashed peer (no goodbye) is removed once the server notices', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice');
  const b = await join(room, 'bob');
  await waitFor(async () => (await callUp(a)) && (await callUp(b)), 'call up');
  const cdp = await b.context().newCDPSession(b);
  cdp.send('Page.crash').catch(() => { }); // never resolves: the renderer is gone
  await waitFor(async () => (await a.locator('#mediaDiv .videoplaceholder').count()) === 1, 'tile removed', 30000);
  await a.context().close(); await b.context().close();
});

// #14: each side asks for Opus DTX + FEC, so a muted mic sends almost nothing.
test('Opus DTX/FEC requested; muting drops the audio packet rate', async () => {
  const room = 'r' + Date.now();
  const trackPcs = () => {
    const O = RTCPeerConnection; window.__raw = []; window.RTCPeerConnection = function (c) { const p = new O(c); __raw.push(p); return p; };
    // Per spec RTCSessionDescription.sdp is readonly (Firefox/Safari ignore writes); Chrome lets it be assigned.
    const g = Object.getOwnPropertyDescriptor(O.prototype, 'localDescription').get;
    Object.defineProperty(O.prototype, 'localDescription', { get() { const d = g.call(this); return d && Object.freeze({ type: d.type, sdp: d.sdp }); } });
  };
  const a = await join(room, 'alice', trackPcs);
  const b = await join(room, 'bob', trackPcs);
  await waitFor(async () => (await liveRemoteAudio(a)) === 1 && (await liveRemoteAudio(b)) === 1, 'remote audio');
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
  await a.context().close(); await b.context().close();
});

test('mute button toggles the mic track', async () => {
  const a = await join('r' + Date.now(), 'alice');
  await waitFor(() => a.evaluate(() => !!allUserStreams[MY_UUID]), 'mic ready');
  const micEnabled = () => a.evaluate(() => allUserStreams[MY_UUID].audiostream.getAudioTracks()[0].enabled);
  await a.click('#muteUnmuteMicBtn');
  assert.strictEqual(await micEnabled(), false);
  assert.ok(await a.locator('#muteUnmuteMicBtn .fa-microphone-alt-slash').count());
  await a.click('#muteUnmuteMicBtn');
  assert.strictEqual(await micEnabled(), true);
  await a.context().close();
});

test('hang up leads to the end screen', async () => {
  const a = await join('r' + Date.now(), 'alice');
  await a.click('#cancelCallBtn');
  await a.waitForURL(/endcall\.html/, { timeout: 5000 });
  await a.context().close();
});

test('browsers without WebRTC get an upgrade notice', async () => {
  const a = await open('r' + Date.now(), 'alice', () => { delete window.RTCPeerConnection; });
  await waitFor(() => a.locator('#unsupported').isVisible(), 'notice visible', 5000);
  await a.context().close();
});

// Dropping UDP breaks the direct P2P path while signaling (TCP) stays up. Needs root for iptables.
const UDP_DROP = 'OUTPUT -p udp ! --dport 53 -m comment --comment basicwebrtc-test -j DROP';
const canDropUdp = (() => { try { require('child_process').execSync('iptables -L -n', { stdio: 'ignore' }); return true; } catch { return false; } })();
const iptables = args => require('child_process').execSync('iptables ' + args);

for (const outage of [15, 45]) test(`call recovers after the direct P2P path drops for ${outage}s`, { skip: !canDropUdp && 'needs root + iptables' }, async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice', trackPcs);
  const b = await join(room, 'bob', trackPcs);
  const iceUp = p => p.evaluate(() => __raw.some(x => ['connected', 'completed'].includes(x.iceConnectionState)));
  await waitFor(async () => (await iceUp(a)) && (await liveRemoteAudio(a)) === 1, 'ICE connected');
  try { for (;;) iptables('-D ' + UDP_DROP + ' 2>/dev/null'); } catch { } // leftovers from a killed run
  iptables('-I ' + UDP_DROP);
  try {
    await waitFor(async () => !(await iceUp(a)) && !(await iceUp(b)), 'ICE disconnected', 15000);
    await waitFor(async () => (await peerStatus(a)) === 'reconnecting…' && (await peerStatus(b)) === 'reconnecting…', 'reconnecting shown');
    await new Promise(r => setTimeout(r, outage * 1000)); // 15s: longer than any give-up timeout; 45s: #22
  } finally {
    iptables('-D ' + UDP_DROP);
  }
  for (const p of [a, b]) {
    await waitFor(async () => (await iceUp(p)) && (await liveRemoteAudio(p)) === 1, 'ICE and audio back', 45000);
    assert.strictEqual(await p.evaluate(() => Object.keys(pcs).length), 1, 'peer kept');
    assert.strictEqual(await p.evaluate(() => __raw.length), 1, 'same connection, not rebuilt');
    await waitFor(async () => (await peerStatus(p)) === '', 'status cleared');
  }
  await a.context().close(); await b.context().close();
});

// #25: an answer still in flight when ICE restarts must not be applied to the restart offer.
test('late answer does not cancel an ICE restart', { skip: !canDropUdp && 'needs root + iptables' }, async () => {
  const room = 'r' + Date.now();
  const trackPcs = () => { const O = RTCPeerConnection; window.__raw = []; window.RTCPeerConnection = function (c) { const p = new O(c); __raw.push(p); return p; }; };
  const a = await join(room, 'alice', trackPcs);
  const b = await join(room, 'bob', trackPcs);
  const iceUp = p => p.evaluate(() => __raw.some(x => ['connected', 'completed'].includes(x.iceConnectionState)));
  await waitFor(async () => (await iceUp(a)) && (await liveRemoteAudio(a)) === 1, 'ICE connected');
  const ufrag = (p, d) => p.evaluate(d => __raw[0][d].sdp.match(/a=ice-ufrag:(\S+)/)[1], d);
  const bobUfrag = await ufrag(b, 'localDescription');
  await a.evaluate(() => { // hold bob's answers on alice until alice has sent an ICE restart offer, then deliver them in order
    const pc = Object.values(pcs)[0], orig = pc.signaling, uf = () => __raw[0].localDescription.sdp.match(/a=ice-ufrag:(\S+)/)[1], u0 = uf();
    const restarted = new Promise(r => { const t = setInterval(() => uf() != u0 && (clearInterval(t), r()), 50); });
    window.__answers = 0;
    pc.signaling = d => d && d.type == 'answer' ? restarted.then(() => orig(d)).finally(() => __answers++) : orig(d);
  });
  await a.click('#addRemoveCameraBtn'); // offer whose answer is held back
  try { for (;;) iptables('-D ' + UDP_DROP + ' 2>/dev/null'); } catch { }
  iptables('-I ' + UDP_DROP);
  try {
    await waitFor(async () => (await a.evaluate(() => __answers >= 2 && __raw[0].signalingState == 'stable')) && (await ufrag(b, 'localDescription')) != bobUfrag, 'restart answered', 30000);
    assert.strictEqual(await ufrag(a, 'currentRemoteDescription'), await ufrag(b, 'localDescription'), 'alice uses bob\'s new ICE credentials');
  } finally {
    iptables('-D ' + UDP_DROP);
  }
  for (const p of [a, b]) await waitFor(async () => (await iceUp(p)) && (await liveRemoteAudio(p)) === 1, 'ICE and audio back', 45000);
  await a.context().close(); await b.context().close();
});

test('rename updates the name for peers, chat and the URL', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice');
  const b = await join(room, 'bob');
  await waitFor(async () => (await connectedPeers(b)) === 1, 'ICE connected');
  a.once('dialog', d => d.accept('zoe smith'));
  await a.click('#moreBtn'); await a.click('#changeNameBtn');
  await waitFor(() => b.evaluate(() => Object.values(allUserStreams).some(s => s.username == 'zoe smith')), 'new name on bob');
  assert.strictEqual(await b.evaluate(() => document.querySelector('#mediaDiv').textContent.includes('ZO')), true, 'initials updated');
  assert.strictEqual(await a.evaluate(() => getUrlParam('username', 'NA')), 'zoe smith', 'kept in URL for reloads');
  await a.click('#moreBtn'); await a.click('#addRemoveChatBtn');
  await a.fill('#chatInputText', 'hi');
  await a.press('#chatInputText', 'Enter');
  await waitFor(() => b.evaluate(() => document.querySelector('#chatText').textContent.includes('zoe smith: hi')), 'chat uses new name');
  await a.context().close(); await b.context().close();
});

test('share button shares the room link without the username', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice', () => { navigator.share = d => { window.__shared = d; return Promise.resolve(); }; });
  await a.click('#moreBtn'); await a.click('#shareBtn');
  const shared = await a.evaluate(() => window.__shared);
  assert.strictEqual(shared.url, `${BASE}#roomname=${room}`);
  await a.context().close();
});

test('share link also drops username and camon from the query string', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice', () => { navigator.share = d => { window.__shared = d; return Promise.resolve(); }; }, '?username=bob&camon=true&x=1');
  await a.click('#moreBtn'); await a.click('#shareBtn');
  const shared = await a.evaluate(() => window.__shared);
  assert.strictEqual(shared.url, `${BASE}?x=1#roomname=${room}`);
  await a.context().close();
});

test('rename keeps other URL params byte-identical and cannot switch them on', async () => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  await a.goto(`${BASE}#roomname=a+b=c&username=alice`);
  await a.click('#joinBtn');
  a.once('dialog', d => d.accept('my camon socketdomain name'));
  await a.click('#moreBtn'); await a.click('#changeNameBtn');
  assert.strictEqual(await a.evaluate(() => location.hash), '#roomname=a+b=c&username=my%20camon%20socketdomain%20name');
  await a.reload();
  assert.deepStrictEqual(await a.evaluate(() => [getUrlParam('camon', false), getUrlParam('socketdomain', false), getUrlParam('username', 'NA')]),
    [false, false, 'my camon socketdomain name']);
  await ctx.close();
});

test('URL params: exact keys, no double #, stray % does not break the page', async () => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const errors = [];
  a.on('pageerror', e => errors.push(e.message));
  await a.goto(`${BASE}#username=bob`); // no roomname: one gets added with &, not a second #
  assert.match(await a.evaluate(() => location.hash), /^#username=bob&roomname=r\d+$/);
  assert.deepStrictEqual(await a.evaluate(() => [username, getUrlParam('roomname', 'unknown') == roomname]), ['bob', true]);
  await a.goto(`${BASE}#roomname=camonday`);
  await a.reload(); // a hash-only goto doesn't reload the page
  assert.strictEqual(await a.evaluate(() => camOnAtStart), false);
  await a.goto(`${BASE}#roomname=100%&username=50%`);
  await a.reload();
  assert.deepStrictEqual(await a.evaluate(() => [getUrlParam('roomname'), username]), ['100%', '50%']);
  assert.deepStrictEqual(errors, []);
  await ctx.close();
});

test('share falls back to a copy dialog when Web Share fails', async () => {
  const a = await join('r' + Date.now(), 'alice', () => { navigator.share = () => Promise.reject(new DOMException('no', 'NotAllowedError')); });
  await a.click('#moreBtn'); await a.click('#shareBtn');
  await waitFor(() => a.locator('#shareDialog').isVisible(), 'share dialog');
  assert.match(await a.inputValue('#shareLink'), /#roomname=r\d+$/);
  await a.context().close();
});

test('without Web Share the dialog copies the link', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice', () => {
    delete Navigator.prototype.share;
    navigator.clipboard.writeText = t => { window.__copied = t; return Promise.resolve(); };
  });
  await a.click('#moreBtn'); await a.click('#shareBtn');
  await a.click('#copyLinkBtn');
  assert.strictEqual(await a.evaluate(() => window.__copied), `${BASE}#roomname=${room}`);
  await a.click('#shareDialog button[value=close]');
  assert.strictEqual(await a.locator('#shareDialog').isVisible(), false);
  await a.context().close();
});

test('camera picker is a touch-sized tab on top of the camera button', async () => {
  const ctx = await browser.newContext({ viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true });
  const a = await ctx.newPage();
  await a.goto(`${BASE}#roomname=r${Date.now()}`);
  await a.click('#joinBtn');
  await waitFor(() => a.locator('#selectCameraBtn').isVisible(), 'picker visible');
  const [cam, pick] = await Promise.all(['#addRemoveCameraBtn', '#selectCameraBtn'].map(s => a.locator(s).boundingBox()));
  assert.ok(pick.y + pick.height <= cam.y + 1 && Math.abs(pick.x - cam.x) <= 1 && Math.abs(pick.width - cam.width) <= 1, 'tab right above the camera button');
  assert.ok(pick.height >= 24 && pick.width >= 40, `touch-sized (${pick.width}x${pick.height})`);
  await a.mouse.click(cam.x + cam.width - 4, cam.y + cam.height / 2); // the button's right edge still toggles the camera
  await waitFor(() => a.evaluate(() => camActive), 'camera on');
  await ctx.close();
});

test('peer joining during fullscreen is still heard', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice', () => Object.defineProperty(document, 'fullscreenElement', { get: () => document.body }));
  const b = await join(room, 'bob');
  await waitFor(async () => (await liveRemoteAudio(a)) === 1, 'remote audio on alice');
  await a.context().close(); await b.context().close();
});

// iOS Safari may refuse to start remote audio without a user gesture: the next tap must start it.
test('remote audio blocked by autoplay starts on the next tap', async () => {
  const blockAutoplay = () => { // not userActivation: page.evaluate counts as a gesture
    let tapped = false;
    window.addEventListener('click', e => tapped ||= e.target.id != 'joinBtn', true); // Join is a tap too: this tests a later one
    document.addEventListener('play', e => { if (!tapped) e.target.pause(); }, true);
  };
  const room = 'r' + Date.now();
  const a = await join(room, 'alice', blockAutoplay);
  const b = await join(room, 'bob');
  await waitFor(async () => (await liveRemoteAudio(a)) === 1, 'remote audio element');
  const paused = () => a.evaluate(() => document.querySelector('#audioStreams audio').paused);
  await waitFor(paused, 'autoplay blocked');
  await a.mouse.click(5, 5);
  await waitFor(async () => !(await paused()), 'audio playing after tap');
  await a.context().close(); await b.context().close();
});

test('chat opens fullscreen on phones and closes again', async () => {
  const ctx = await browser.newContext({ viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true });
  const a = await ctx.newPage();
  await a.goto(`${BASE}#roomname=r${Date.now()}`);
  await a.click('#joinBtn');
  await a.click('#moreBtn'); await a.click('#addRemoveChatBtn');
  assert.notStrictEqual(await a.evaluate(() => document.activeElement.id), 'chatInputText', 'no keyboard popping up on touch');
  const box = await a.locator('#chatDiv').boundingBox();
  assert.deepStrictEqual([box.x, box.y, box.width, box.height], [0, 0, 320, 568]);
  assert.ok(parseFloat(await a.$eval('#chatInputText', e => getComputedStyle(e).fontSize)) >= 16, 'no iOS zoom on focus');
  await a.click('#chatCloseBtn');
  assert.strictEqual(await a.locator('#chatDiv').isVisible(), false);
  await ctx.close();
});

test('unnamed sender cannot fake a styled name', async () => {
  const room = 'r' + Date.now();
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  await a.goto(`${BASE}#roomname=${room}`); // no username
  await a.click('#joinBtn');
  const b = await join(room, 'bob');
  await waitFor(async () => (await connectedPeers(b)) === 1, 'ICE connected');
  await a.click('#moreBtn'); await a.click('#addRemoveChatBtn');
  await a.fill('#chatInputText', 'bob: send me the code');
  await a.press('#chatInputText', 'Enter');
  await waitFor(() => b.evaluate(() => document.querySelectorAll('#chatText > div').length > 0), 'message on bob');
  assert.strictEqual(await b.evaluate(() => document.querySelector('#chatText .chatName')), null);
  await ctx.close(); await b.context().close();
});

test('desktop chat fits short windows above the phone breakpoint', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 500 } });
  const a = await ctx.newPage();
  await a.goto(`${BASE}#roomname=r${Date.now()}`);
  await a.click('#joinBtn');
  await a.click('#moreBtn'); await a.click('#addRemoveChatBtn');
  assert.ok((await a.locator('#chatDiv').boundingBox()).y >= 0, 'header on screen');
  await a.click('#chatCloseBtn');
  assert.strictEqual(await a.locator('#chatDiv').isVisible(), false);
  await ctx.close();
});

test('Enter in the share link keeps the dialog open', async () => {
  const a = await join('r' + Date.now(), 'alice', () => { delete Navigator.prototype.share; });
  await a.click('#moreBtn'); await a.click('#shareBtn');
  await a.press('#shareLink', 'Enter');
  assert.strictEqual(await a.locator('#shareDialog').isVisible(), true);
  await a.context().close();
});

test('chat, rename and share live in the more menu', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice');
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
  await a.context().close();
});

test('all call buttons fit on screen from phone to small desktop widths', async () => {
  const phone = 'Mozilla/5.0 (Linux; Android 14) Mobile'; // phones hide the screen share button
  for (const [width, height, userAgent] of [[320, 568, phone], [568, 320, phone], [520, 800], [600, 800]]) {
    const ctx = await browser.newContext({ viewport: { width, height }, userAgent });
    const a = await ctx.newPage();
    await a.goto(`${BASE}#roomname=r${Date.now()}`);
    await a.click('#joinBtn');
    await waitFor(() => a.locator('#selectCameraBtn').isVisible(), 'camera picker shown (2 fake cams)');
    const overflow = await a.evaluate(() => [...document.querySelectorAll('.callBtn')]
      .filter(b => b.offsetParent && b.getBoundingClientRect().right > innerWidth).map(b => b.id));
    assert.deepStrictEqual(overflow, [], `${width}x${height}`);
    await ctx.close();
  }
});

// #26: local media state
const noCamera = () => { const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = c => c.video ? Promise.reject(new DOMException('no camera', 'NotFoundError')) : gum(c); };
const liveVideoLeft = page => page.evaluate(() => __streams.flatMap(s => s.getVideoTracks()).filter(t => t.readyState == 'live').length);
const slowMedia = () => { // records every stream handed out; camera and screen take 500ms
  const md = navigator.mediaDevices, gum = md.getUserMedia.bind(md), gdm = md.getDisplayMedia.bind(md);
  window.__streams = [];
  const slow = f => async c => { const s = await f(c); if (c.video) await new Promise(r => setTimeout(r, 500)); __streams.push(s); return s; };
  md.getUserMedia = slow(gum); md.getDisplayMedia = slow(gdm);
};

test('camon=1 without a working camera still joins with audio', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice', noCamera, '?camon=1');
  const b = await join(room, 'bob');
  await waitFor(async () => (await liveRemoteAudio(b)) === 1, 'alice heard by bob');
  await a.context().close(); await b.context().close();
});

test('rapid camera/screen clicks leave no live stream behind', async () => {
  const a = await join('r' + Date.now(), 'alice', slowMedia);
  await waitFor(() => a.evaluate(() => !!allUserStreams[MY_UUID].audiostream), 'mic ready');
  await a.click('#addRemoveCameraBtn'); await a.click('#addRemoveCameraBtn'); // double click
  await waitFor(() => a.evaluate(() => camActive), 'camera on');
  await new Promise(r => setTimeout(r, 1000));
  await a.click('#addRemoveCameraBtn');
  assert.strictEqual(await liveVideoLeft(a), 0, 'double click');
  await a.click('#addRemoveScreenBtn'); await a.click('#addRemoveCameraBtn'); // camera while the screen picker is open
  await new Promise(r => setTimeout(r, 1500));
  assert.ok(!(await a.evaluate(() => camActive && screenActive)), 'not both active');
  await a.evaluate(() => (camActive || screenActive) && stopVideo());
  assert.strictEqual(await liveVideoLeft(a), 0, 'camera during screen picker');
  await a.context().close();
});

test('cancelling the screen picker keeps the camera', async () => {
  const a = await join('r' + Date.now(), 'alice', () => { navigator.mediaDevices.getDisplayMedia = () => Promise.reject(new DOMException('cancelled', 'NotAllowedError')); });
  await a.click('#addRemoveCameraBtn');
  await waitFor(() => a.evaluate(() => camActive), 'camera on');
  await a.click('#addRemoveScreenBtn');
  await new Promise(r => setTimeout(r, 300));
  assert.ok(await a.evaluate(() => camActive && allUserStreams[MY_UUID].videostream.getVideoTracks()[0].readyState == 'live'));
  await a.context().close();
});

test('unplugged camera turns the camera off', async () => {
  const a = await join('r' + Date.now(), 'alice');
  await a.click('#addRemoveCameraBtn');
  await waitFor(() => a.evaluate(() => camActive), 'camera on');
  await a.evaluate(() => allUserStreams[MY_UUID].videostream.getVideoTracks()[0].dispatchEvent(new Event('ended')));
  assert.deepStrictEqual(await a.evaluate(() => [camActive, !!allUserStreams[MY_UUID].videostream, $('#addRemoveCameraBtn').style.color]), [false, false, 'black']);
  await a.context().close();
});

test('hang up releases mic, camera and socket right away, once', async () => {
  const a = await join('r' + Date.now(), 'alice');
  await waitFor(() => a.evaluate(() => !!allUserStreams[MY_UUID].audiostream), 'mic ready');
  await a.click('#addRemoveCameraBtn');
  await waitFor(() => a.evaluate(() => camActive), 'camera on');
  await a.evaluate(() => { window.__tracks = [allUserStreams[MY_UUID].audiostream, allUserStreams[MY_UUID].videostream].flatMap(s => s.getTracks()); });
  await a.evaluate(() => { $('#cancelCallBtn').click(); $('#cancelCallBtn').click(); });
  assert.deepStrictEqual(await a.evaluate(() => [__tracks.map(t => t.readyState).join(), socket.disconnected, document.querySelectorAll('#topDiv').length]), ['ended,ended', true, 1]);
  await a.context().close();
});

test('mic denied shows a message and "Try again" joins once allowed', async () => {
  const room = 'r' + Date.now();
  const a = await open(room, 'alice', () => {
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = c => c.audio && !sessionStorage.micOk ? Promise.reject(new DOMException('denied', 'NotAllowedError')) : gum(c);
  });
  await waitFor(() => a.locator('#micError').isVisible(), 'message shown');
  await a.evaluate(() => sessionStorage.micOk = 1); // user allows the mic
  await a.click('#micError button');
  await a.click('#joinBtn');
  const b = await join(room, 'bob');
  await waitFor(async () => (await liveRemoteAudio(b)) === 1, 'alice heard by bob');
  await a.context().close(); await b.context().close();
});

// #27: the mute icon survives re-layouts and reaches peers who join later.
test('remote mute icon survives re-layout and is shown to late-joining peers', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice');
  const b = await join(room, 'bob');
  await waitFor(async () => (await connectedPeers(b)) === 1, 'first pair');
  await a.click('#muteUnmuteMicBtn');
  await waitFor(() => b.locator('.audioMuted').count(), 'mute icon on bob');
  const c = await join(room, 'carol');
  const aId = await a.evaluate(() => MY_UUID);
  for (const p of [b, c]) {
    await waitFor(() => p.evaluate(() => document.querySelector('#mediaDiv').textContent.includes('CA')), 'carol\'s tile');
    await waitFor(() => p.evaluate(id => !!byId(id)?.querySelector('.audioMuted'), aId), 'alice muted');
  }
  await b.evaluate(() => updateUserLayout()); // any later re-layout keeps it
  assert.ok(await b.evaluate(id => !!byId(id)?.querySelector('.audioMuted'), aId), 'still muted after re-layout');
  for (const p of [a, b, c]) await p.context().close();
});

test('layout skipped in fullscreen is redone on exit', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice', () => { window.__fs = null; Object.defineProperty(document, 'fullscreenElement', { get: () => window.__fs }); });
  const b = await join(room, 'bob');
  await waitFor(async () => (await connectedPeers(a)) === 1, 'connected');
  const bId = await b.evaluate(() => MY_UUID);
  await a.evaluate(() => window.__fs = document.body);
  await b.context().close();
  await waitFor(() => a.evaluate(() => !Object.keys(pcs).length), 'bob removed');
  await a.evaluate(() => { window.__fs = null; document.dispatchEvent(new Event('fullscreenchange')); });
  assert.ok(await a.evaluate(id => !byId(id), bId), 'bob\'s tile gone');
  await a.context().close();
});

test('late signaling from a departed peer creates no connection', async () => {
  const a = await join('r' + Date.now(), 'alice');
  await waitFor(() => a.evaluate(() => socket.connected), 'connected');
  await a.evaluate(() => {
    socket.listeners('userDiscconected')[0]('ghost');
    socket.listeners('signaling')[0]({ fromUUID: 'ghost', signalingData: { candidate: 'candidate:1 1 udp 1 1.2.3.4 9 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
  });
  assert.deepStrictEqual(await a.evaluate(() => [Object.keys(pcs), !!byId('ghost')]), [[], false]);
  await a.context().close();
});

test('tile initials do not split an emoji', async () => {
  const a = await join('r' + Date.now(), 'a😀b');
  await waitFor(() => a.evaluate(() => byId(MY_UUID)?.querySelector('.userPlaceholder').textContent), 'own tile');
  assert.strictEqual(await a.evaluate(() => byId(MY_UUID).querySelector('.userPlaceholder').textContent), 'A😀');
  await a.context().close();
});

test('picture-in-picture survives a re-layout (#27)', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice');
  const b = await join(room, 'bob');
  await waitFor(async () => (await connectedPeers(b)) === 1, 'ICE connected');
  await a.click('#addRemoveCameraBtn');
  await waitFor(() => remoteVideoShown(b), 'remote video on bob');
  await b.click('#mediaDiv .pipBtn');
  await waitFor(() => b.evaluate(() => !!document.pictureInPictureElement), 'bob in PiP');
  const c = await join(room, 'carol'); // peer joins: re-layout on bob
  await waitFor(async () => (await connectedPeers(b)) === 2, 'carol connected');
  await new Promise(r => setTimeout(r, 500));
  assert.ok(await b.evaluate(() => document.pictureInPictureElement?.isConnected && !document.pictureInPictureElement.paused), 'still in PiP and playing');
  for (const p of [a, b, c]) await p.context().close();
});

test('lobby: nobody joins until Join, then with the name typed there', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice');
  const b = await (await browser.newContext()).newPage();
  await b.goto(`${BASE}#roomname=${room}`);
  await waitFor(() => b.locator('#lobby').isVisible(), 'lobby shown');
  for (const call of ['#mediaControllContainer', '#mediaDiv']) assert.strictEqual(await b.locator(call).isVisible(), false, `${call} hidden in the lobby`);
  assert.strictEqual(await b.inputValue('#lobbyCamera'), 'off', 'camera off');
  assert.strictEqual(await b.locator('#lobbyVideo').isVisible(), false);
  const cam = await b.evaluate(() => [...document.querySelectorAll('#lobbyCamera option')].at(-1).value);
  await b.selectOption('#lobbyCamera', cam);
  await waitFor(() => b.evaluate(c => $('#lobbyVideo').srcObject?.getVideoTracks()[0]?.getSettings().deviceId == c && $('#lobbyVideo').checkVisibility(), cam), 'preview of the picked camera');
  await b.selectOption('#lobbyCamera', 'off');
  await waitFor(() => b.evaluate(() => !camActive && !$('#lobbyVideo').checkVisibility()), 'camera off again');
  assert.ok(await b.evaluate(() => $('#lobbyMic').options.length > 1 && $('#micMeter') instanceof HTMLMeterElement), 'mic picker and level meter');
  await new Promise(r => setTimeout(r, 1500));
  assert.strictEqual(await a.evaluate(() => Object.keys(pcs).length), 0, 'not joined from the lobby');
  assert.deepStrictEqual(await b.evaluate(() => ['data-1p-ignore', 'data-lpignore', 'data-bwignore', 'data-form-type'].map(a => $('#nameInput').hasAttribute(a))), [true, true, true, true], 'password managers told to skip the name field');
  await b.fill('#nameInput', 'carol');
  await b.click('#joinBtn');
  assert.strictEqual(await b.locator('#lobby').isVisible(), false, 'lobby closed');
  assert.ok(await b.locator('#mediaControllContainer').isVisible(), 'call controls shown');
  await waitFor(async () => (await connectedPeers(a)) === 1, 'ICE connected');
  await waitFor(() => a.evaluate(() => Object.values(allUserStreams).some(s => s.username == 'carol')), 'name from the lobby');
  await a.context().close(); await b.context().close();
});

// The track the sender actually transmits, on the raw RTCPeerConnection.
const sentMicId = page => page.evaluate(() => __raw.at(-1).getSenders().find(s => s.track?.kind == 'audio')?.track.getSettings().deviceId);

test('mic picker switches the mic sent to the other peer', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice', trackPcs);
  const b = await join(room, 'bob');
  await waitFor(async () => (await connectedPeers(b)) === 1 && (await liveRemoteAudio(b)) === 1, 'ICE and audio');
  await waitFor(() => a.locator('#selectMicBtn').isVisible(), 'mic picker visible');
  const cur = await sentMicId(a);
  const other = await a.evaluate(cur => [...document.querySelectorAll('#micSelect option')].find(o => o.value != cur && o.value != 'default').value, cur);
  await a.selectOption('#micSelect', other);
  await waitFor(async () => (await sentMicId(a)) === other, 'sent mic switched');
  assert.strictEqual(await a.evaluate(() => webRTCConfig.stream.getAudioTracks().length), 1, 'one mic track');
  await waitFor(async () => (await liveRemoteAudio(b)) === 1, 'remote audio after switch');
  await a.context().close(); await b.context().close();
});

test('an unplugged mic is replaced by another one, the call keeps sound', async () => {
  const room = 'r' + Date.now();
  const hideUnplugged = () => {
    const md = navigator.mediaDevices, enumerate = md.enumerateDevices.bind(md);
    md.enumerateDevices = async () => (await enumerate()).filter(d => d.deviceId != window.__unplugged);
  };
  const a = await join(room, 'alice', `(${trackPcs})(); (${hideUnplugged})();`);
  const b = await join(room, 'bob');
  await waitFor(async () => (await connectedPeers(b)) === 1 && (await liveRemoteAudio(b)) === 1, 'ICE and audio');
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
  await a.context().close(); await b.context().close();
});

test('with no mic left after an unplug, the next mic plugged in is used', async () => {
  const a = await open('r' + Date.now(), 'alice', () => {
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
  await a.context().close();
});

test('name, mic and camera choice survive a reload of the tab, not a new tab', async () => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  await a.goto(`${BASE}#roomname=r${Date.now()}`);
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
  await a.goto(`${BASE}#roomname=r${Date.now()}x`); // other room, same tab
  await a.reload();
  await waitFor(() => a.locator('#lobby').isVisible(), 'lobby shown');
  assert.strictEqual(await a.inputValue('#nameInput'), 'dora');
  assert.strictEqual(await a.evaluate(() => webRTCConfig.stream.getAudioTracks()[0].getSettings().deviceId), mic, 'mic kept');
  await waitFor(async () => (await a.inputValue('#lobbyMic')) === mic, 'lobby shows the mic');
  await waitFor(() => a.evaluate(c => allUserStreams[MY_UUID].videostream?.getVideoTracks()[0].getSettings().deviceId == c, cam), 'camera kept, and on as before');
  await waitFor(async () => (await a.inputValue('#lobbyCamera')) === cam, 'lobby shows the camera');
  const fresh = await ctx.newPage();
  await fresh.goto(`${BASE}#roomname=r${Date.now()}`);
  await waitFor(() => fresh.locator('#lobby').isVisible(), 'lobby shown');
  assert.strictEqual(await fresh.inputValue('#nameInput'), '', 'new tab starts empty');
  await ctx.close();
});

test('lobby: quick device picks run one at a time, no second mic or camera leaks', async () => {
  const a = await open('r' + Date.now(), 'alice');
  await waitFor(() => a.evaluate(() => $('#lobbyMic').options.length > 2), 'mic list');
  await a.evaluate(() => { // two picks before the first switch is done, like arrow keys on a focused dropdown
    const [, x, y] = [...$('#lobbyMic').options].map(o => o.value);
    for (const v of [x, y]) { $('#lobbyMic').value = v; $('#lobbyMic').dispatchEvent(new Event('change')); }
  });
  await a.selectOption('#lobbyCamera', await a.evaluate(() => $('#lobbyCamera').options[1].value));
  await waitFor(() => a.evaluate(() => camActive), 'camera on');
  await a.evaluate(() => { const [, x, y] = [...$('#lobbyCamera').options].map(o => o.value); for (const v of [y, x]) { $('#lobbyCamera').value = v; $('#lobbyCamera').dispatchEvent(new Event('change')); } });
  await new Promise(r => setTimeout(r, 1500));
  assert.deepStrictEqual(await a.evaluate(() => [webRTCConfig.stream.getAudioTracks().length, allUserStreams[MY_UUID].videostream.getVideoTracks().length]), [1, 1]);
  assert.ok(await a.evaluate(() => $('#lobbyMic').value == webRTCConfig.stream.getAudioTracks()[0].getSettings().deviceId), 'dropdown shows the mic in use');
  await a.click('#joinBtn');
  assert.strictEqual(await a.evaluate(() => $('#lobbyVideo').srcObject), null, 'hidden preview let go after Join');
  await a.context().close();
});

// Before camera permission, browsers list a camera as a placeholder: no label, deviceId "".
const noCamPermission = () => {
  const md = navigator.mediaDevices, enumerate = md.enumerateDevices.bind(md), gum = md.getUserMedia.bind(md);
  let granted = false;
  md.getUserMedia = async c => { const s = await gum(c); granted ||= !!c.video; return s; };
  md.enumerateDevices = async () => (await enumerate()).map(d => d.kind != 'videoinput' || granted ? d
    : { kind: d.kind, deviceId: '', label: '', groupId: '' }).filter((d, i, l) => d.deviceId || l.findIndex(e => e.kind == d.kind) == i);
};

test('lobby: the placeholder camera listed before permission turns the camera on', async () => {
  const a = await open('r' + Date.now(), 'alice', noCamPermission);
  await waitFor(() => a.evaluate(() => $('#lobbyCamera').options.length == 2), 'one placeholder camera');
  await a.selectOption('#lobbyCamera', { index: 1 });
  await waitFor(() => a.evaluate(() => camActive && $('#lobbyVideo').checkVisibility()), 'camera on with preview');
  await waitFor(() => a.evaluate(() => $('#lobbyCamera').options.length == 3 && $('#lobbyCamera').value == allUserStreams[MY_UUID].videostream.getVideoTracks()[0].getSettings().deviceId), 'real cameras listed, the one in use picked');
  await a.context().close();
});

test('lobby: a camera prompt answered with no goes back to Off', async () => {
  const a = await open('r' + Date.now(), 'alice', () => {
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = c => c.video ? Promise.reject(new DOMException('denied', 'NotAllowedError')) : gum(c);
  });
  await waitFor(() => a.evaluate(() => $('#lobbyCamera').options.length > 1), 'camera listed');
  await a.selectOption('#lobbyCamera', { index: 1 });
  await waitFor(async () => await a.inputValue('#lobbyCamera') == 'off', 'dropdown back to Off');
  await a.context().close();
});

test('lobby: a camera picked right away is not switched off by camon', async () => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  await a.goto(`${BASE}#roomname=r${Date.now()}&camon=1`);
  await waitFor(() => a.locator('#lobby').isVisible(), 'lobby');
  await a.selectOption('#lobbyCamera', await a.evaluate(() => [...$('#lobbyCamera').options].at(-1).value)); // within camon's first second
  await new Promise(r => setTimeout(r, 1800));
  assert.ok(await a.evaluate(() => camActive), 'camera still on');
  await ctx.close();
});

test('a camera that ended is not turned on again after a reload', async () => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  await a.goto(`${BASE}#roomname=r${Date.now()}`);
  await waitFor(() => a.locator('#lobby').isVisible(), 'lobby');
  await a.selectOption('#lobbyCamera', await a.evaluate(() => [...$('#lobbyCamera').options].at(-1).value));
  await waitFor(() => a.evaluate(() => camActive), 'camera on');
  await a.evaluate(() => allUserStreams[MY_UUID].videostream.getVideoTracks()[0].dispatchEvent(new Event('ended'))); // unplugged
  await waitFor(() => a.evaluate(() => !camActive), 'camera off');
  await a.reload();
  await waitFor(() => a.locator('#lobby').isVisible(), 'lobby');
  await new Promise(r => setTimeout(r, 1500));
  assert.strictEqual(await a.evaluate(() => camActive), false);
  await ctx.close();
});

test('a denied mic is asked for once, also with a saved mic', async () => {
  const a = await open('r' + Date.now(), 'alice', () => {
    sessionStorage.mic = 'some-saved-mic';
    window.__asked = 0;
    navigator.mediaDevices.getUserMedia = () => (__asked++, Promise.reject(new DOMException('denied', 'NotAllowedError')));
  });
  await waitFor(() => a.locator('#micError').isVisible(), 'message shown');
  assert.strictEqual(await a.evaluate(() => __asked), 1);
  await a.context().close();
});

test('closed room: anyone locks, a newcomer knocks, any member lets in or denies', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice');
  const b = await join(room, 'bob');
  await waitFor(async () => (await connectedPeers(b)) === 1, 'ICE connected');
  await b.click('#moreBtn'); await b.click('#lockBtn');
  await waitFor(() => a.evaluate(() => $('#chatText').textContent.includes('bob locked the room')), 'alice told');
  assert.match(await a.textContent('#lockBtn'), /Unlock room/);
  const knock = async name => {
    const p = await open(room, name);
    await p.click('#joinBtn');
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
  for (const p of [a, b, c, d]) await p.context().close();
});

test('the lock message uses the name from the server while the peer is still unnamed', async () => {
  const a = await join('r' + Date.now(), 'alice');
  await a.evaluate(() => socket.listeners('locked')[0]({ locked: true, by: 'x', name: 'zed' }));
  assert.match(await a.textContent('#chatText'), /zed locked the room/);
  await a.evaluate(() => socket.listeners('locked')[0]({ locked: false, by: 'x', name: 'NA' }));
  assert.match(await a.textContent('#chatText'), /Someone unlocked the room/);
  await a.context().close();
});

test('the first one in the lobby can open the room closed', async () => {
  const room = 'r' + Date.now();
  const a = await open(room, 'alice');
  await waitFor(() => a.locator('#closedInput').isVisible(), 'choice shown to the first one');
  await a.check('#closedInput');
  await a.click('#joinBtn');
  await waitFor(async () => /Unlock room/.test(await a.textContent('#lockBtn')), 'room closed');
  const b = await open(room, 'bob');
  await b.waitForFunction(() => !$('#lobby').hidden);
  await b.evaluate(() => new Promise(r => socket.emit('roomInfo', roomname, r))); // answered in order: the lobby's own ask is done
  assert.strictEqual(await b.locator('#closedInput').isVisible(), false, 'not offered when someone is in');
  await b.click('#joinBtn');
  await waitFor(async () => /let you in/.test(await b.textContent('#lobbyMsg')), 'bob knocks');
  for (const p of [a, b]) await p.context().close();
});

test('a closed pick from a lobby someone joined meanwhile: told the room is open, no pick at the door', async () => {
  const room = 'r' + Date.now();
  const a = await open(room, 'alice'), c = await open(room, 'carol');
  for (const p of [a, c]) await waitFor(() => p.locator('#closedInput').isVisible(), 'room empty: choice shown');
  const b = await join(room, 'bob'); // open
  await waitFor(async () => /Lock room/.test(await b.textContent('#lockBtn')), 'bob in');
  await a.check('#closedInput');
  await a.click('#joinBtn');
  await waitFor(() => a.evaluate(() => $('#chatText').textContent.includes('the room is open')), 'alice told');
  assert.match(await a.textContent('#lockBtn'), /Lock room/);
  assert.strictEqual(await a.isChecked('#closedInput'), false, 'pick cleared after joining');
  const d = await open(room, 'dave'); // a hidden pick that is still ticked (Firefox restores it on reload) counts for nothing
  await d.waitForFunction(() => !$('#lobby').hidden);
  await d.evaluate(() => new Promise(r => socket.emit('roomInfo', roomname, r)));
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
  for (const p of [a, b, c, d]) await p.context().close();
});

test('knock banners work for any knocker UUID, also one that spells an element id', async () => {
  const a = await join('r' + Date.now(), 'alice');
  await waitFor(() => a.evaluate(() => allUserStreams[MY_UUID].status === ''), 'joined'); // the join ack clears #knocks; the lobby already hides on Join
  await a.evaluate(() => ['s', 'x'].forEach(UUID => socket.listeners('knock')[0]({ UUID, name: UUID }))); // "knock" + "s" == "knocks"
  assert.strictEqual(await a.locator('.knock').count(), 2);
  await a.evaluate(() => socket.listeners('knockDone')[0]('s'));
  assert.deepStrictEqual(await a.locator('.knock').allTextContents(), ['x wants to joinLet inDeny']);
  await a.context().close();
});

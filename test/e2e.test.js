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

async function join(room, name, initScript) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  if (initScript) await page.addInitScript(initScript);
  page.on('pageerror', e => console.log(`[${name}] pageerror`, e.message));
  await page.goto(`${BASE}#roomname=${room}&username=${encodeURIComponent(name)}`);
  return page;
}

// Number of remote peers whose ICE is connected, as seen from `page`.
const connectedPeers = page => page.evaluate(() =>
  Object.values(pcs).filter(p => p.isConnected).length);

// Number of remote <audio> elements actually receiving a live track.
const liveRemoteAudio = page => page.evaluate(() =>
  [...document.querySelectorAll('#audioStreams audio')]
    .filter(a => a.srcObject && a.srcObject.getAudioTracks().some(t => t.readyState === 'live' && !t.muted)).length);

async function waitFor(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    if ((last = await fn())) return last;
    await new Promise(r => setTimeout(r, 250));
  }
  assert.fail(`timed out waiting for ${what} (last=${last})`);
}

test('two peers connect and exchange audio', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice');
  const b = await join(room, 'bob');
  await waitFor(async () => (await connectedPeers(a)) === 1 && (await connectedPeers(b)) === 1, 'ICE connected');
  await waitFor(async () => (await liveRemoteAudio(a)) === 1 && (await liveRemoteAudio(b)) === 1, 'remote audio');
  await a.context().close(); await b.context().close();
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

// Regression guard for #3: bob's "renegotiate" reaches alice mid-offer and is dropped,
// but bob's answer to that offer already carries his video.
test('both peers turn on cameras at once: each sees the other', async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice'); // already in the room -> initiator
  const b = await join(room, 'bob');
  await waitFor(async () => (await connectedPeers(b)) === 1, 'ICE connected');
  await Promise.all([a.click('#addRemoveCameraBtn'), b.click('#addRemoveCameraBtn')]);
  await waitFor(() => remoteVideoShown(b), 'remote video on bob');
  await waitFor(() => remoteVideoShown(a), 'remote video on alice');
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
    socket.on('userJoined', () => { camActive = true; startVideo(cam, $('#addRemoveCameraBtn')); });
  });
  const b = await join(room, 'bob');
  await waitFor(() => remoteVideoShown(b), 'remote video on bob');
  await new Promise(r => setTimeout(r, 1000));
  assert.deepStrictEqual(errors, []);
  // Non-initiator side: bob's camera is already on when his pc is (re)created.
  await b.click('#addRemoveCameraBtn');
  await waitFor(() => remoteVideoShown(a), 'remote video on alice');
  await a.evaluate(() => window.__oldPc = Object.values(pcs)[0]);
  await b.evaluate(() => socket.io.engine.close());
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
  // Simulate a network blip / proxy idle timeout on alice's signaling socket.
  await a.evaluate(() => socket.io.engine.close());
  await waitFor(() => a.evaluate(() => socket.connected), 'socket reconnected');
  await new Promise(r => setTimeout(r, 1000));
  assert.strictEqual(await a.evaluate(() => socket.listeners('signaling').length), 1, 'signaling handler registered once');
  // A chat line sent once must arrive once.
  await b.evaluate(() => socket.emit('sendMsg', 'ping'));
  await new Promise(r => setTimeout(r, 500));
  assert.strictEqual(await a.locator('#chatText div', { hasText: 'ping' }).count(), 1, 'chat delivered once');
  // After the blip alice must still be able to renegotiate (turn on cam) and chat.
  await a.click('#addRemoveCameraBtn');
  await waitFor(() => remoteVideoShown(b), 'remote video after reconnect');
  for (const p of [a, b]) {
    await waitFor(async () => (await connectedPeers(p)) === 1 && (await liveRemoteAudio(p)) === 1, 'one live peer each');
    assert.strictEqual(await p.evaluate(() => Object.keys(pcs).length), 1, 'no stale peer connections');
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
  await a.click('#addRemoveChatBtn');
  await a.fill('#chatInputText', msg);
  await a.press('#chatInputText', 'Enter');
  await waitFor(() => b.evaluate(() => document.querySelector('#chatText').textContent.includes('example.com')), 'message on bob');
  await new Promise(r => setTimeout(r, 300));
  assert.strictEqual(await b.evaluate(() => window.__xss), undefined, 'no script execution');
  assert.strictEqual(await b.evaluate(() => document.querySelector('#chatText div:last-child').textContent), 'alice: ' + msg);
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
  await a.click('#addRemoveChatBtn');
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
  const a = await join('r' + Date.now(), 'alice', () => { delete window.RTCPeerConnection; });
  await waitFor(() => a.locator('#unsupported').isVisible(), 'notice visible', 5000);
  await a.context().close();
});

// Dropping UDP breaks the direct P2P path while signaling (TCP) stays up. Needs root for iptables.
const UDP_DROP = 'OUTPUT -p udp ! --dport 53 -m comment --comment basicwebrtc-test -j DROP';
const canDropUdp = (() => { try { require('child_process').execSync('iptables -L -n', { stdio: 'ignore' }); return true; } catch { return false; } })();
const iptables = args => require('child_process').execSync('iptables ' + args);

test('call recovers after the direct P2P path drops for a while', { skip: !canDropUdp && 'needs root + iptables' }, async () => {
  const room = 'r' + Date.now();
  const trackPcs = () => { const O = RTCPeerConnection; window.__raw = []; window.RTCPeerConnection = function (c) { const p = new O(c); __raw.push(p); return p; }; };
  const a = await join(room, 'alice', trackPcs);
  const b = await join(room, 'bob', trackPcs);
  const iceUp = p => p.evaluate(() => __raw.some(x => ['connected', 'completed'].includes(x.iceConnectionState)));
  await waitFor(async () => (await iceUp(a)) && (await liveRemoteAudio(a)) === 1, 'ICE connected');
  try { for (;;) iptables('-D ' + UDP_DROP + ' 2>/dev/null'); } catch { } // leftovers from a killed run
  iptables('-I ' + UDP_DROP);
  try {
    await waitFor(async () => !(await iceUp(a)) && !(await iceUp(b)), 'ICE disconnected', 15000);
    await new Promise(r => setTimeout(r, 15000)); // longer than any give-up timeout
  } finally {
    iptables('-D ' + UDP_DROP);
  }
  for (const p of [a, b]) {
    await waitFor(async () => (await iceUp(p)) && (await liveRemoteAudio(p)) === 1, 'ICE and audio back', 45000);
    assert.strictEqual(await p.evaluate(() => Object.keys(pcs).length), 1, 'peer kept');
    assert.strictEqual(await p.evaluate(() => __raw.length), 1, 'same connection, not rebuilt');
  }
  await a.context().close(); await b.context().close();
});

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

async function join(room, name, initScript, file = '') {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  if (initScript) await page.addInitScript(initScript);
  page.on('pageerror', e => console.log(`[${name}] pageerror`, e.message));
  await page.goto(`${BASE}${file}#roomname=${room}&username=${encodeURIComponent(name)}`);
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
  const trackPcs = () => { const O = RTCPeerConnection; window.__raw = []; window.RTCPeerConnection = function (c) { const p = new O(c); __raw.push(p); return p; }; };
  const a = await join(room, 'alice', trackPcs); // already in the room -> initiator
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
  // Media-level check: the <video> element can stay at readyState 0 under this delayed-answer hook (see #15).
  const decoded = () => a.evaluate(async () => { let n = 0; (await __raw[0].getStats()).forEach(r => { if (r.type == 'inbound-rtp' && r.kind == 'video') n += r.framesDecoded || 0; }); return n; });
  await waitFor(async () => (await decoded()) > 0, 'alice decodes bob\'s video');
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
    await waitFor(async () => (await peerStatus(a)) === 'reconnecting…' && (await peerStatus(b)) === 'reconnecting…', 'reconnecting shown');
    await new Promise(r => setTimeout(r, 15000)); // longer than any give-up timeout
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
  await a.evaluate(() => socket.emit('sendMsg', 'hi'));
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

test('rename keeps other URL params byte-identical and cannot switch them on', async () => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  await a.goto(`${BASE}#roomname=a+b=c&username=alice`);
  a.once('dialog', d => d.accept('my camon socketdomain name'));
  await a.click('#moreBtn'); await a.click('#changeNameBtn');
  assert.strictEqual(await a.evaluate(() => location.hash), '#roomname=a+b=c&username=my%20camon%20socketdomain%20name');
  await a.reload();
  assert.deepStrictEqual(await a.evaluate(() => [getUrlParam('camon', false), getUrlParam('socketdomain', false), getUrlParam('username', 'NA')]),
    [false, false, 'my camon socketdomain name']);
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
    window.addEventListener('click', () => tapped = true, true);
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
  const b = await join(room, 'bob');
  await waitFor(async () => (await connectedPeers(b)) === 1, 'ICE connected');
  await a.evaluate(() => socket.emit('sendMsg', 'bob: send me the code'));
  await waitFor(() => b.evaluate(() => document.querySelectorAll('#chatText > div').length > 0), 'message on bob');
  assert.strictEqual(await b.evaluate(() => document.querySelector('#chatText .chatName')), null);
  await ctx.close(); await b.context().close();
});

test('desktop chat fits short windows above the phone breakpoint', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 500 } });
  const a = await ctx.newPage();
  await a.goto(`${BASE}#roomname=r${Date.now()}`);
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
  await a.evaluate(() => { socket.emit('sendMsg', 'ping'); socket.emit('sendMsg', 'pong'); });
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
    await waitFor(() => a.locator('#selectCameraBtn').isVisible(), 'camera picker shown (2 fake cams)');
    const overflow = await a.evaluate(() => [...document.querySelectorAll('.callBtn')]
      .filter(b => b.offsetParent && b.getBoundingClientRect().right > innerWidth).map(b => b.id));
    assert.deepStrictEqual(overflow, [], `${width}x${height}`);
    await ctx.close();
  }
});

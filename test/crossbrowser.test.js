// Cross-browser calls: Chromium <-> Firefox (FIREFOX=1, Playwright's Firefox, not as root) and Chromium <-> real Safari (SAFARI=1, macOS).
// Safari is driven through safaridriver's WebDriver HTTP API with plain fetch, no extra dependency.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { chromium, firefox } = require('playwright-core');

const PORT = 3100 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}/`;
const WD = `http://127.0.0.1:${PORT + 1000}`;
let chrome, fox, driver, session;

async function wd(method, path, body) {
  const res = await fetch(WD + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const { value } = await res.json();
  if (!res.ok) throw new Error(`webdriver ${path}: ${JSON.stringify(value)}`);
  return value;
}

async function waitFor(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    if ((last = await fn())) return last;
    await new Promise(r => setTimeout(r, 250));
  }
  assert.fail(`timed out waiting for ${what} (last=${last})`);
}

const CONNECTED = 'Object.values(pcs).filter(p => p.isConnected).length';
// Audio both ways, seen from Chromium's stats (engine-independent): RTP received, and the peer's receiver reports on what Chromium sent.
const AUDIO_BOTH_WAYS = async () => { let rx = 0, tx = 0; for (const p of __raw) (await p.getStats()).forEach(r => {
  if (r.kind == 'audio' && r.type == 'inbound-rtp') rx += r.packetsReceived;
  if (r.kind == 'audio' && r.type == 'remote-inbound-rtp') tx++;
}); return rx > 0 && tx > 0; };
// Every video tile is actually playing frames (own camera and the peer's), seen from inside the browser.
const VIDEOS_PLAYING = `(() => { const v = [...document.querySelectorAll('#mediaDiv video')]; return v.length == 2 && v.every(v => !v.paused && v.videoWidth > 0); })()`;
const REMOTE_VIDEO = () => [...document.querySelectorAll('#mediaDiv video')].some(v => v.srcObject && v.videoWidth > 0 && !v.classList.contains('mirror'));
// Init script (as in e2e.test.js): keeps the raw RTCPeerConnections in window.__raw.
const trackPcs = () => { const O = RTCPeerConnection; window.__raw = []; window.RTCPeerConnection = function (c) { const p = new O(c); __raw.push(p); return p; }; };
// Printed on failure: ICE and DTLS state, candidates and stats: RTP in/out (packets, frames and keyframes decoded), candidate pairs, data channel.
const STATE = `Promise.all((window.__raw || []).map(async p => ({ sig: p.signalingState, ice: p.iceConnectionState, conn: p.connectionState, gather: p.iceGatheringState,
  local: p.localDescription?.sdp.match(/a=candidate.*/g), remote: p.remoteDescription?.sdp.match(/a=candidate.*/g),
  stats: [...(await p.getStats().catch(() => [])).values()].filter(s => /^((in|out)bound-rtp|candidate-pair|transport|data-channel|(local|remote)-candidate)$/.test(s.type)) }))).then(JSON.stringify)`;
// The peer's ICE username once ICE is up and nothing is being negotiated: an ICE restart changes it.
const ICE_UP = `(p => p.signalingState == 'stable' && ['connected', 'completed'].includes(p.iceConnectionState) && p.remoteDescription.sdp.match(/a=ice-ufrag:(\\S+)/)[1])(__raw.at(-1))`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
// The element's clock while it plays (a video: with frames), else -1.
const clock = sel => `(m => m && !m.paused && (m.tagName == 'AUDIO' || m.videoWidth > 0) ? m.currentTime : -1)(document.querySelector(${JSON.stringify(sel)}))`;
const plays = async (b, sel) => { const t = await b.evaluate(clock(sel)); await sleep(400); return t >= 0 && await b.evaluate(clock(sel)) > t; };
// Sound arrives: RTP packets with energy in them, not silence.
const AUDIO_IN = `Promise.all(__raw.map(p => p.getStats())).then(rs => { let n = 0, e = 0; for (const r of rs) r.forEach(s => { if (s.type == 'inbound-rtp' && s.kind == 'audio') n += s.packetsReceived, e += s.totalAudioEnergy || 0; }); return n > 0 && e > 0; })`;
const MEDIA = `Promise.all((window.__raw || []).map(p => p.getStats())).then(rs => JSON.stringify({
  els: [...document.querySelectorAll('video, audio')].map(m => ({ tag: m.tagName, id: m.id, cls: m.className, shown: !!m.offsetParent, paused: m.paused, muted: m.muted, vol: m.volume, w: m.videoWidth, ready: m.readyState, t: m.currentTime, err: m.error?.message,
    tracks: m.srcObject?.getTracks().map(t => [t.kind, t.readyState, t.muted ? 'muted' : '', t.enabled ? '' : 'disabled'].join(' ')) })),
  mic: webRTCConfig.stream?.getTracks().map(t => [t.label, t.readyState, t.muted ? 'muted' : '', t.enabled ? '' : 'disabled'].join(' ')),
  meter: document.getElementById('micMeter').value, chimeCtx: typeof audioOut == 'undefined' ? null : audioOut?.state, camActive,
  rtp: rs.flatMap(r => [...r.values()]).filter(s => /^(in|out)bound-rtp$|^media-source$/.test(s.type)).map(s => ({ type: s.type, kind: s.kind, mid: s.mid, sent: s.packetsSent, recv: s.packetsReceived, energy: s.totalAudioEnergy, level: s.audioLevel, frames: s.framesDecoded ?? s.framesEncoded, active: s.active })),
}))`;
before(async () => {
  if (!process.env.FIREFOX && !process.env.SAFARI) return;
  require('./boot')({ listen_port: PORT });
  chrome = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  if (process.env.FIREFOX) fox = await firefox.launch({ firefoxUserPrefs: {
    'media.navigator.streams.fake': true,
    'media.navigator.permission.disabled': true,
    'media.peerconnection.ice.obfuscate_host_addresses': false, // plain host candidates, no mDNS
    'media.peerconnection.ice.loopback': true,
    'media.autoplay.default': 0,
  } });
  if (process.env.SAFARI) {
    driver = spawn('safaridriver', ['-p', String(PORT + 1000)], { stdio: 'inherit' });
    await waitFor(() => fetch(WD + '/status').then(r => r.ok, () => false), 'safaridriver');
    // Safari under automation uses mock capture devices; these drop the insecure-origin and host-candidate filters.
    const caps = { capabilities: { alwaysMatch: {
      browserName: 'safari',
      'webkit:WebRTC': { DisableInsecureMediaCapture: true, DisableICECandidateFiltering: true },
    } } };
    // ponytail: one retry of the session only (never of a test): on CI, launching Safari sometimes times out (#82)
    ({ sessionId: session } = await wd('POST', '/session', caps).catch(async e => {
      console.log('webdriver session failed, retrying once:', e.message);
      await new Promise(r => setTimeout(r, 2000));
      return wd('POST', '/session', caps);
    }));
  }
});

after(async () => {
  if (session) await wd('DELETE', `/session/${session}`).catch(() => { });
  driver?.kill();
  await fox?.close();
  await chrome?.close();
});

// A call between Chromium and the other browser. Who joins first decides who sends the offer, so both orders run.
// The other browser then turns its camera on: it sends on the video slot it answered (#57), no renegotiation.
async function call(other, otherFirst) {
  const room = 'x' + Date.now(), log = [];
  const page = await (await chrome.newContext()).newPage();
  page.on('console', m => log.push('[chromium] ' + m.text()));
  await page.addInitScript(trackPcs);
  const joinChromium = () => page.goto(`${BASE}#roomname=${room}`).then(() => page.click('#joinBtn'));
  const joinOther = async () => { // through the lobby: it shows once the mic is there
    await other.go(`${BASE}#roomname=${room}`);
    await waitFor(() => other.evaluate("!document.getElementById('lobby').hidden"), 'other browser in the lobby');
    if (other == safari) await other.evaluate(`(${trackPcs})()`); // no init scripts over WebDriver: before the join is soon enough
    await other.evaluate("document.getElementById('joinBtn').click()");
  };
  if (otherFirst) { await joinOther(); await joinChromium(); } else { await joinChromium(); await joinOther(); }
  try {
    await waitFor(() => page.evaluate(CONNECTED), 'chromium connected');
    await waitFor(() => other.evaluate(CONNECTED), 'other browser connected');
    await waitFor(() => page.evaluate(AUDIO_BOTH_WAYS), 'audio both ways');
    await other.evaluate("camActive || document.getElementById('addRemoveCameraBtn').click()"); // on, not toggled: the last call's camera state is remembered
    await waitFor(() => page.evaluate(REMOTE_VIDEO), 'video from the other browser');
    const ufrags = [await page.evaluate(ICE_UP), await other.evaluate(ICE_UP)]; // #88: the initiator restarts ICE, as after an outage
    await (otherFirst ? other : page).evaluate('__raw.at(-1).restartIce()');
    await waitFor(async () => [await page.evaluate(ICE_UP), await other.evaluate(ICE_UP)].every((u, i) => u && u != ufrags[i]), 'ICE restarted and up on both sides');
    await page.click('#addRemoveCameraBtn');
    await waitFor(() => other.evaluate(VIDEOS_PLAYING), 'other browser shows both videos');
  } catch (e) {
    console.log(log.concat(other.log || []).join('\n'));
    console.log('[chromium state]', await page.evaluate(STATE).catch(String));
    console.log('[other state]', await other.evaluate(STATE).catch(String));
    console.log('[other media]', await other.evaluate(MEDIA).catch(String)); // elements, mic track and RTP counters (#118)
    throw e;
  } finally {
    await page.context().close();
    await other.leave();
  }
}

async function firefoxPage() {
  const page = await (await fox.newContext()).newPage(), log = [];
  page.on('console', m => log.push('[firefox] ' + m.text()));
  await page.addInitScript(trackPcs);
  return { log, go: url => page.goto(url), evaluate: expr => page.evaluate(expr), leave: () => page.context().close() };
}
const safari = {
  go: url => wd('POST', `/session/${session}/url`, { url }),
  evaluate: expr => wd('POST', `/session/${session}/execute/sync`, { script: `return ${expr}`, args: [] }),
  leave: () => wd('POST', `/session/${session}/url`, { url: 'about:blank' }), // hang up before the next call
};

// What a Safari user sees and hears, as reported from real calls: the own camera in the lobby and in the call, the peer's voice, and the peer hears Safari.
// Every step is checked even after one failed, so a single (expensive) macOS run names all of them.
async function safariCall(camAtStart) {
  const room = 'y' + Date.now(), log = [], failed = [];
  const page = await (await chrome.newContext()).newPage();
  page.on('console', m => log.push('[chromium] ' + m.text()));
  await page.addInitScript(trackPcs);
  const check = async (what, fn, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn().catch(e => (log.push(`[${what}] ${e.message}`), false))) return; await sleep(250); }
    failed.push(what);
    console.log(`FAILED: ${what}\n[safari media]`, await safari.evaluate(MEDIA).catch(String));
  };
  try {
    await safari.go(BASE + 'endcall.html'); // same origin, no call: set what the tab remembers
    await safari.evaluate(`(sessionStorage.clear(), sessionStorage.camOn = '${camAtStart ? 1 : ''}')`);
    await safari.go(`${BASE}#roomname=${room}`);
    await waitFor(() => safari.evaluate("!document.getElementById('lobby').hidden"), 'safari in the lobby');
    await safari.evaluate(`(${trackPcs})()`);
    if (!camAtStart) await safari.evaluate("pick('#lobbyCamera', document.getElementById('lobbyCamera').options[1].value)");
    await check('own camera in the lobby', () => plays(safari, '#lobbyVideo'));
    await check('mic meter moves in the lobby', () => safari.evaluate("document.getElementById('micMeter').value > 0"));
    await safari.evaluate("document.getElementById('joinBtn').click()");
    await check('own camera in the call, alone', () => plays(safari, '#mediaDiv video'));
    await page.goto(`${BASE}#roomname=${room}`);
    await page.click('#joinBtn');
    await check('chromium connected', () => page.evaluate(CONNECTED), 30000);
    await check('safari connected', () => safari.evaluate(CONNECTED), 30000);
    await check("safari plays the peer's audio", () => plays(safari, '#audioStreams audio'));
    await check('safari receives sound', () => safari.evaluate(AUDIO_IN));
    await check('chromium receives sound', () => page.evaluate(AUDIO_IN));
    await check('own camera in the call, with a peer', () => plays(safari, '.selfPreview video'));
    await check("chromium shows safari's camera", () => plays(page, '.videoplaceholder:not(.selfPreview) video'));
    await page.click('#addRemoveCameraBtn');
    await check("safari shows the peer's camera", () => plays(safari, '.videoplaceholder:not(.selfPreview) video'));
    await check("own camera beside the peer's", () => plays(safari, '.selfPreview video'));
    await check("safari still plays the peer's audio", () => plays(safari, '#audioStreams audio'));
    console.log('[safari media at the end]', await safari.evaluate(MEDIA).catch(String));
    if (failed.length) console.log(log.join('\n'));
    assert.deepEqual(failed, []);
  } finally {
    await page.context().close();
    await safari.leave();
  }
}
for (const otherFirst of [false, true]) {
  const order = otherFirst ? ' (joins first)' : ' (joins second)';
  test('Firefox calls Chromium' + order, { skip: !process.env.FIREFOX && 'set FIREFOX=1 (npx playwright-core install firefox; not as root)' },
    async () => call(await firefoxPage(), otherFirst));
  test('Safari calls Chromium' + order, { skip: !process.env.SAFARI && 'set SAFARI=1 (macOS)' },
    () => call(safari, otherFirst));
}
// After the calls above: these leave the camera on in Safari's one tab, and the first call there turns it on in a running call (#57).
for (const camAtStart of [false, true]) test('Safari: own camera and sound, camera ' + (camAtStart ? 'on from the last call' : 'picked in the lobby'),
  { skip: !process.env.SAFARI && 'set SAFARI=1 (macOS)' }, () => safariCall(camAtStart));

// DIAGNOSTIC (Firefox): the own preview goes black when the peer turns its camera on, and stays black after own camera off/on.
const LOOK = async () => { const out = [];
  for (const v of document.querySelectorAll('#mediaDiv video, #lobbyVideo')) {
    const c = document.createElement('canvas'); c.width = 32; c.height = 24;
    const g = c.getContext('2d'); let lum = -1;
    try { g.drawImage(v, 0, 0, 32, 24); const d = g.getImageData(0, 0, 32, 24).data; let sum = 0; for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2]; lum = Math.round(sum / (32 * 24 * 3)); } catch (e) { lum = String(e); }
    const r = v.getBoundingClientRect(), cs = getComputedStyle(v), q = v.getVideoPlaybackQuality?.();
    out.push({ self: !!v.closest('.selfPreview') || v.classList.contains('mirror'), id: v.id, lum, paused: v.paused, ready: v.readyState, w: v.videoWidth, h: v.videoHeight, t: +v.currentTime.toFixed(2), frames: q?.totalVideoFrames,
      box: [r.x | 0, r.y | 0, r.width | 0, r.height | 0], vis: cs.visibility + '/' + cs.display + '/' + cs.opacity, ar: v.parentElement.style.getPropertyValue('--ar'), err: v.error?.message,
      tracks: v.srcObject?.getTracks().map(t => [t.kind, t.readyState, t.muted ? 'muted' : '', t.enabled ? '' : 'disabled', JSON.stringify(t.getSettings())].join(' ')) });
  }
  return JSON.stringify({ n: Object.keys(allUserStreams).length, camActive, videos: out }); };
for (const foxFirst of [false, true]) test('DIAGNOSTIC Firefox own preview, firefox joins ' + (foxFirst ? 'first' : 'second'), { skip: !process.env.FIREFOX && 'set FIREFOX=1' }, async () => {
  const room = 'z' + Date.now();
  const page = await (await chrome.newContext()).newPage();
  const fp = await (await fox.newContext()).newPage();
  fp.on('console', m => console.log('[firefox console]', m.text()));
  fp.on('pageerror', e => console.log('[firefox pageerror]', e.message));
  const shot = async sel => { const b = await fp.locator(sel).first().screenshot().catch(e => null); return b ? b.length : 'no shot'; };
  const join = async p => { await p.goto(`${BASE}#roomname=${room}`); await p.click('#joinBtn'); };
  if (foxFirst) { await join(fp); await join(page); } else { await join(page); await join(fp); }
  await waitFor(() => fp.evaluate(CONNECTED), 'firefox connected');
  await fp.click('#addRemoveCameraBtn');
  await waitFor(() => fp.evaluate(() => document.querySelectorAll('#mediaDiv video').length == 1), 'firefox own video');
  await sleep(1500);
  console.log('[fox before]', await fp.evaluate(LOOK), 'shot', await shot('#mediaDiv video'));
  for (let i = 0; i < 8; i++) {
    await page.click('#addRemoveCameraBtn'); // peer camera on, then off, ...
    await sleep(i % 2 ? 600 : 1500);
    console.log(`[fox peer cam ${i % 2 ? 'off' : 'on'} #${i}]`, await fp.evaluate(LOOK), 'shot', await shot('.selfPreview video'));
    if (i == 3) await fp.evaluate(() => { for (let k = 0; k < 5; k++) updateUserLayout(); }); // a burst, as on a join
  }
  await page.evaluate("camActive || document.getElementById('addRemoveCameraBtn').click()");
  await sleep(1500);
  console.log('[fox peer cam on, final]', await fp.evaluate(LOOK), 'shot', await shot('.selfPreview video'));
  await fp.click('#addRemoveCameraBtn'); await sleep(500); await fp.click('#addRemoveCameraBtn'); await sleep(2000);
  console.log('[fox own cam off/on]', await fp.evaluate(LOOK), 'shot', await shot('.selfPreview video'));
  console.log('[chromium sees]', await page.evaluate(LOOK));
  await page.context().close(); await fp.context().close();
});

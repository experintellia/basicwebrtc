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
const REMOTE_VIDEO = () => [...document.querySelectorAll('#mediaDiv video')].some(v => v.srcObject && v.videoWidth > 0 && !v.style.transform.includes('scaleX'));
// Init script (as in e2e.test.js): keeps the raw RTCPeerConnections in window.__raw.
const trackPcs = () => { const O = RTCPeerConnection; window.__raw = []; window.RTCPeerConnection = function (c) { const p = new O(c); __raw.push(p); return p; }; };
// Printed on failure: ICE state and candidates (the other side's only in Playwright browsers, Safari has no __raw).
const STATE = `JSON.stringify((window.__raw || []).map(p => ({ sig: p.signalingState, ice: p.iceConnectionState, gather: p.iceGatheringState,
  local: p.localDescription?.sdp.match(/a=candidate.*/g), remote: p.remoteDescription?.sdp.match(/a=candidate.*/g) })))`;

before(async () => {
  if (!process.env.FIREFOX && !process.env.SAFARI) return;
  process.env.listen_port = String(PORT);
  process.env.listen_ip = '127.0.0.1';
  require('../server.js'); // ponytail: in-process, runner exits via --test-force-exit
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
    ({ sessionId: session } = await wd('POST', '/session', { capabilities: { alwaysMatch: {
      browserName: 'safari',
      'webkit:WebRTC': { DisableInsecureMediaCapture: true, DisableICECandidateFiltering: true },
    } } }));
  }
});

after(async () => {
  if (session) await wd('DELETE', `/session/${session}`).catch(() => { });
  driver?.kill();
  await fox?.close();
  await chrome?.close();
});

// A call between Chromium and the other browser. Who joins first decides who sends the offer, so both orders run.
// The other browser then turns its camera on: renegotiation from its side (Safari's null-mid transceiver path).
async function call(other, otherFirst) {
  const room = 'x' + Date.now(), log = [];
  const page = await (await chrome.newContext()).newPage();
  page.on('console', m => log.push('[chromium] ' + m.text()));
  await page.addInitScript(trackPcs);
  const joinChromium = () => page.goto(`${BASE}#roomname=${room}&username=chromium`);
  const joinOther = () => other.go(`${BASE}#roomname=${room}&username=other`);
  if (otherFirst) { await joinOther(); await joinChromium(); } else { await joinChromium(); await joinOther(); }
  try {
    await waitFor(() => page.evaluate(CONNECTED), 'chromium connected');
    await waitFor(() => other.evaluate(CONNECTED), 'other browser connected');
    await waitFor(() => page.evaluate(AUDIO_BOTH_WAYS), 'audio both ways');
    await other.evaluate("document.getElementById('addRemoveCameraBtn').click()");
    await waitFor(() => page.evaluate(REMOTE_VIDEO), 'video from the other browser');
  } catch (e) {
    console.log(log.concat(other.log || []).join('\n'));
    console.log('[chromium state]', await page.evaluate(STATE).catch(String));
    console.log('[other state]', await other.evaluate(STATE).catch(String));
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

for (const otherFirst of [false, true]) {
  const order = otherFirst ? ' (joins first)' : ' (joins second)';
  test('Firefox calls Chromium' + order, { skip: !process.env.FIREFOX && 'set FIREFOX=1 (npx playwright-core install firefox; not as root)' },
    async () => call(await firefoxPage(), otherFirst));
  test('Safari calls Chromium' + order, { skip: !process.env.SAFARI && 'set SAFARI=1 (macOS)' },
    () => call(safari, otherFirst));
}

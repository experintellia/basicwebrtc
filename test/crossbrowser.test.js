// Cross-browser calls: Chromium <-> Firefox (Playwright's Firefox, if installed) and Chromium <-> real Safari (SAFARI=1, macOS).
// Safari is driven through safaridriver's WebDriver HTTP API with plain fetch, no extra dependency.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { chromium, firefox } = require('playwright-core');

const PORT = 3100 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}/`;
const WD = `http://127.0.0.1:${PORT + 1000}`;
const hasFirefox = fs.existsSync(firefox.executablePath());
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
const LIVE_AUDIO = `[...document.querySelectorAll('#audioStreams audio')]
  .filter(a => a.srcObject && a.srcObject.getAudioTracks().some(t => t.readyState === 'live' && !t.muted)).length`;

before(async () => {
  if (!hasFirefox && !process.env.SAFARI) return;
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
  if (hasFirefox) fox = await firefox.launch({ firefoxUserPrefs: {
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

// Chromium joins `room`, the other browser joins via `go`; both must see the peer and hear its audio.
// On failure both sides' ICE state and candidates are printed, since the other browser is not available locally.
const STATE = `JSON.stringify((window.__raw || []).map(p => ({ sig: p.signalingState, ice: p.iceConnectionState, gather: p.iceGatheringState,
  local: p.localDescription?.sdp.match(/a=candidate.*/g), remote: p.remoteDescription?.sdp.match(/a=candidate.*/g) })))`;
// Init script (as in e2e.test.js): keeps the raw RTCPeerConnections in window.__raw.
// Also logs each pc's state changes and descriptions (type + ice-ufrag), so a failed run shows the order of events.
const trackPcs = () => {
  const O = RTCPeerConnection, t0 = Date.now(); window.__raw = [];
  const log = (...a) => console.log('pc', Date.now() - t0, ...a);
  const ufrag = d => (d?.sdp?.match(/a=ice-ufrag:(\S+)/) || [])[1];
  window.RTCPeerConnection = function (c) {
    const p = new O(c); __raw.push(p);
    p.addEventListener('signalingstatechange', () => log('sig', p.signalingState));
    p.addEventListener('iceconnectionstatechange', () => log('ice', p.iceConnectionState));
    for (const f of ['setLocalDescription', 'setRemoteDescription']) {
      const orig = p[f].bind(p);
      const desc = () => f == 'setLocalDescription' ? p.localDescription : p.remoteDescription;
      p[f] = d => orig(d).then(() => log(f, desc()?.type, ufrag(desc())), e => { log(f, d?.type, 'error', e.message); throw e; });
    }
    return p;
  };
};
async function call(room, go, evaluate) {
  const page = await (await chrome.newContext()).newPage();
  page.on('console', m => console.log('[chromium]', m.text()));
  await page.addInitScript(trackPcs);
  await page.goto(`${BASE}#roomname=${room}&username=chromium`);
  await go(`${BASE}#roomname=${room}&username=other`);
  try {
    await waitFor(() => page.evaluate(CONNECTED), 'chromium connected');
    await waitFor(() => evaluate(CONNECTED), 'other browser connected');
    await waitFor(() => page.evaluate(LIVE_AUDIO), 'audio at chromium');
    await waitFor(() => evaluate(LIVE_AUDIO), 'audio at other browser');
  } catch (e) {
    console.log('[chromium state]', await page.evaluate(STATE).catch(String));
    console.log('[other state]', await evaluate(STATE).catch(String));
    throw e;
  }
}

test('Chromium and Firefox connect and exchange audio', { skip: !hasFirefox && 'npx playwright-core install firefox' }, async () => {
  const page = await (await fox.newContext()).newPage();
  page.on('console', m => console.log('[firefox]', m.text()));
  await page.addInitScript(trackPcs);
  await call('f' + Date.now(), url => page.goto(url), expr => page.evaluate(expr));
});

test('Chromium and Safari connect and exchange audio', { skip: !process.env.SAFARI && 'set SAFARI=1 (macOS)' }, async () => {
  await call('s' + Date.now(), url => wd('POST', `/session/${session}/url`, { url }),
    expr => wd('POST', `/session/${session}/execute/sync`, { script: `return ${expr}`, args: [] }));
});

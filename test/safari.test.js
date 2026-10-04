// Cross-browser: Chromium calls real Safari (macOS CI only). Run: SAFARI=1 node --test --test-force-exit test/safari.test.js
// Safari is driven through safaridriver's WebDriver HTTP API with plain fetch, no extra dependency.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');

const PORT = 3100 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}/`;
const WD = `http://127.0.0.1:${PORT + 1000}`;
let browser, driver, session;

async function wd(method, path, body) {
  const res = await fetch(WD + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const { value } = await res.json();
  if (!res.ok) throw new Error(`webdriver ${path}: ${JSON.stringify(value)}`);
  return value;
}
const safariEval = script => wd('POST', `/session/${session}/execute/sync`, { script, args: [] });

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
  if (!process.env.SAFARI) return;
  process.env.listen_port = String(PORT);
  process.env.listen_ip = '127.0.0.1';
  require('../server.js'); // ponytail: in-process, runner exits via --test-force-exit
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  driver = spawn('safaridriver', ['-p', String(PORT + 1000)], { stdio: 'inherit' });
  await waitFor(() => fetch(WD + '/status').then(r => r.ok, () => false), 'safaridriver');
  // Safari under automation uses mock capture devices; these drop the insecure-origin and host-candidate filters.
  ({ sessionId: session } = await wd('POST', '/session', { capabilities: { alwaysMatch: {
    browserName: 'safari',
    'webkit:WebRTC': { DisableInsecureMediaCapture: true, DisableICECandidateFiltering: true },
  } } }));
});

after(async () => {
  if (session) await wd('DELETE', `/session/${session}`).catch(() => { });
  driver?.kill();
  await browser?.close();
});

test('Chromium and Safari connect and exchange audio', { skip: !process.env.SAFARI && 'set SAFARI=1 (macOS)' }, async () => {
  const room = 'x' + Date.now();
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}#roomname=${room}&username=chromium`);
  await wd('POST', `/session/${session}/url`, { url: `${BASE}#roomname=${room}&username=safari` });
  await waitFor(() => page.evaluate(CONNECTED), 'chromium connected');
  await waitFor(() => safariEval(`return ${CONNECTED}`), 'safari connected');
  await waitFor(() => page.evaluate(LIVE_AUDIO), 'audio from safari');
  await waitFor(() => safariEval(`return ${LIVE_AUDIO}`), 'audio from chromium');
});

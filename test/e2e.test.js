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
      '--use-fake-device-for-media-stream',
      '--disable-features=WebRtcHideLocalIpsWithMdns', // plain host candidates, no mDNS
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
});

after(async () => {
  await browser?.close();
});

async function join(room, name) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log(`[${name}] pageerror`, e.message));
  await page.goto(`${BASE}#roomname=${room}&username=${name}`);
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
  await waitFor(() => b.evaluate(() => [...document.querySelectorAll('#mediaDiv video')]
    .some(v => v.srcObject && v.videoWidth > 0 && !v.style.transform.includes('scaleX'))), 'remote video on bob');
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

test('peer leaves: the other side cleans up', { todo: "BUG: main.js uses $('audio'+UUID), missing '#'" }, async () => {
  const room = 'r' + Date.now();
  const a = await join(room, 'alice');
  const b = await join(room, 'bob');
  await waitFor(async () => (await liveRemoteAudio(a)) === 1, 'remote audio');
  await b.context().close();
  await waitFor(async () => (await a.locator('#audioStreams audio').count()) === 0, 'audio element removed');
  await a.context().close();
});

test('signaling socket reconnect keeps the call working', { todo: 'BUG: handlers re-registered on every reconnect' }, async () => {
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
  await waitFor(() => b.evaluate(() => [...document.querySelectorAll('#mediaDiv video')]
    .some(v => v.srcObject && v.videoWidth > 0 && !v.style.transform.includes('scaleX'))), 'remote video after reconnect');
  await a.context().close(); await b.context().close();
});

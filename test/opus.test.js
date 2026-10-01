// Unit test for opusParams() in web/js/ezWebRTC.js (loaded with vm, no browser).
const { test } = require('node:test');
const assert = require('node:assert');
const ctx = { window: {} };
require('vm').runInNewContext(require('fs').readFileSync(__dirname + '/../web/js/ezWebRTC.js', 'utf8'), ctx);

test('opusParams adds usedtx and useinbandfec on the opus fmtp line, whatever its PT', () => {
  const sdp = 'm=audio 9 UDP/TLS/RTP/SAVPF 109 0\r\na=rtpmap:109 opus/48000/2\r\na=fmtp:109 minptime=10\r\na=rtpmap:0 PCMU/8000\r\n';
  assert.strictEqual(ctx.opusParams(sdp), sdp.replace('minptime=10', 'minptime=10;usedtx=1;useinbandfec=1'));
});

test('opusParams leaves the SDP unchanged if the params are already there', () => {
  const sdp = 'a=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1;usedtx=1\r\n';
  assert.strictEqual(ctx.opusParams(sdp), sdp);
});

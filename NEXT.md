# Next steps — reliability & minimalism

Context for a fresh thread. Goal (see AGENTS.md): reliable, minimal, fully P2P
voice chat for 2–3 people, no accounts, everything E2E-encrypted (DTLS-SRTP),
TURN only as fallback. Workflow is **test-driven**: write/​un-skip a failing
test first, see it red, then the smallest fix. Run with `npm test`
(node:test + headless Chromium with fake media; server runs in-process).

## Already done (PR experintellia/basicwebrtc#2, branch `claude/intelligent-hypatia-otw1ip`)

- Test suite: 12 browser e2e + 5 server-protocol tests.
- Fixed: signaling-reconnect handler stacking, server reconnect race,
  peer cleanup on leave (`removePeer`), UUID key check, chat/username XSS,
  ICE `urls` key.
- Removed: Electron screen-share code, jQuery, adapter.js. Added
  unsupported-browser screen.

## 1. Recovery when the direct P2P (ICE) connection fails  — highest value

The signaling-socket drop is handled, but a failure of the browser-to-browser
connection is not. Symptoms in `web/js/ezWebRTC.js`:

- `negotiate()` returns early on a dropped offer without resetting
  `makingOffer`, so camera/screen changes can stop reaching peers permanently.
- Only the initiator restarts ICE on `failed`/`disconnected`; the answerer
  just waits.
- After ~10s disconnected, `closed` fires and `removePeer` deletes the tile.
  If ICE later recovers, the peer never reappears (`stream` won't re-fire).
- Several `setRemoteDescription` / `addIceCandidate` calls lack `await`/`catch`.

Test approach: in Playwright, force an ICE failure mid-call (e.g. block the
peer traffic, or call an internal restart), then assert the connection
recovers and audio flows again — rather than the tile vanishing for good.
Keep the fix minimal: the perfect-negotiation pattern already partly present
is the reference; don't add a library.

## 2. TURN / relay robustness

- `iceservers.json` only offers `turn:...:443` over UDP. Add
  `turn:host:443?transport=tcp` (and/or `turns:`) so UDP-blocked networks
  still connect. Still E2E-encrypted — relays forward ciphertext only.
- **Security:** the TURN shared secret is committed in `iceservers.json`
  even though it's in `.gitignore` (it was committed before being ignored).
  Rotate the secret, `git rm --cached iceservers.json`, ship an
  `iceservers.example.json`.

## 3. Smaller follow-ups

- `web/js/socket.io.min.js` (52KB) is the last vendored blob — justified
  (signaling transport), leave it.
- Add a GitHub Actions workflow running `npm test` on PRs.
- Consider dropping video/screenshare only if you ever want voice-only; for
  now they stay (user wants them).

## Deploy reminder

`call.simonlaux.de` runs the pre-fix chat code (live XSS). Deploy PR #2 or at
least commits `bf11eed` + `6a38526`.

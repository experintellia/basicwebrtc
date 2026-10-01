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

## Done in the follow-up

- **ICE recovery:** a peer is no longer dropped 10s after the P2P path breaks.
  Tiles go away only when the server says the peer left; the initiator keeps
  restarting ICE (`pc.restartIce()` → `negotiate()`). Dropped offers reset
  `makingOffer`; signaling errors are awaited and logged. Test drops UDP via
  iptables for 15s (needs root, skipped otherwise; CI runs it with sudo).
- **TURN over TCP:** README documents `turn:host:443?transport=tcp` next to UDP.
- **Secret:** `iceservers.json` is untracked; tracked `iceservers.example.json`
  (public STUN only) is the fallback when it's missing.
- **CI:** `.github/workflows/test.yml` runs `npm test` on push/PR.

## Still open — needs the server owner

1. **Before the next deploy:** `updateserver.sh` does `git pull`, which now
   *deletes* the live `iceservers.json` (it's untracked upstream). Back it up
   first: `cp iceservers.json ~/ && git pull && cp ~/iceservers.json .`
   Without it the server still runs, but STUN-only (no TURN fallback).
2. **Rotate the TURN secret** (it's in git history — treat as compromised):
   new `authSecret` in coturn + `turnServerCredential` in the live
   `iceservers.json`.
3. In that same live file, switch to `"urls": ["turn:HOST:443", "turn:HOST:443?transport=tcp"]`.
4. Deploy (live instance is behind on the chat fixes).

## Notes

- `web/js/socket.io.min.js` is the last vendored blob — justified, leave it.
- Video and screen share stay — both are wanted features.
- UI framework: decided **no React/Preact for now** — plain DOM is enough.
- Answerer still never restarts ICE itself; fine while signaling is up, since
  the initiator sees the same failure. Revisit if one-sided failures show up.
- Pre-existing: an answerer's `"renegotiate"` request is dropped if the
  initiator has an offer in flight (`negotiate()` returns on `makingOffer`),
  so an answerer's cam/screen change can miss that peer. Fix: remember it and
  call `negotiate()` again after the answer is applied.

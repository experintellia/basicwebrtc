# AGENTS.md

This repo is a fork of `cracker0dks/basicwebrtc`.

- Never open pull requests, issues, or comments against the upstream repo (`cracker0dks/basicwebrtc`).
- Never push to the `upstream` remote. Push only to `origin` (`experintellia/basicwebrtc`).
- PRs, if any, target `experintellia/basicwebrtc` only (`gh pr create --repo experintellia/basicwebrtc`).

## Project goals

Reliable, minimal, fully peer-to-peer voice chat for 2-3 people. No accounts.
Prefer direct P2P connections; TURN is only a fallback. Everything stays end-to-end encrypted (WebRTC DTLS-SRTP).
Keep the code small: fewer lines and dependencies beat features.

## Test-driven development

All changes are test-driven: first write (or un-`todo`) a test that fails for the bug or feature, see it fail, then make the smallest change that makes it pass.
Run the suite with `npm test` (node:test + headless Chromium with fake media, see `test/`).

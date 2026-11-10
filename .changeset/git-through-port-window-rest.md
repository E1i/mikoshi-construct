---
'mikoshi-construct': patch
---

The window, ci, supervisor, tree and remaining scripts now run git only through `scripts/ports/git.ts`. Eighteen files call `processGit` instead of spawning git themselves, and each call keeps its arguments and its outcome. The port now also takes input, an environment, a timeout, a larger buffer, and visible errors. It gains `readOrNull` and an asynchronous `readLater`, and both have in-memory twins. Four files are named exceptions in the git concept's detector (`GIT_BEYOND_THE_PORT`) because the dependency boundary keeps the port from reaching them:

- `src/detect/git.ts`: `src` imports nothing from `scripts`.
- `scripts/construct/check-acceptance.mjs`: a template carrier.
- `scripts/core/node.ts` and `scripts/core/push-policy.ts`: the core contour imports nothing from ports.

A seal test, `scripts/tests/ports/git-seal-window-rest.test.ts`, fails on any git call outside the port. The ratchet's `overlaps:git` goes down from 27 to 0, and `supervisor.ts` from 1190 lines to 1187.

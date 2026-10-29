---
'mikoshi-construct': patch
---

`npm pack` builds `dist` first through a `prepack` hook, which replaces `prepublishOnly`, so a locally packed tarball no longer ships a stale build. The bus supervisor names any running bus process that comes from another package, such as one a probe's temporary install left behind. A witness refusal now carries the last lines of the command's output instead of only its closing `ELIFECYCLE` line, and the witness worker runs its commands with `CI=true`.

The local pre-push selection no longer turns into a full run because of a card's own `.changeset/*.md` note; `.changeset/config.json` still does. A change to `src/card/risk.ts` now covers the MORSE `cli` and `rules` tests that read its rule.

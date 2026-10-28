---
"mikoshi-construct": patch
---

The browser lab's `hands` takes `--profile-from` and copies the base profile once per session, runs each object in its own session with the extension config whatever the position of `-s`, works under `--evidence <dir>` so no `.playwright-cli/` lands in the repository root, and on `close` writes the full console stream of its session to `console.json`.

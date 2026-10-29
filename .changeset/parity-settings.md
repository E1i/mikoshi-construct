---
"mikoshi-construct": patch
---

`init` now writes the budget layer the factory runs on: `.claude/eddies.json` with the session, agent and run limits, and the `eddies` guard and prompt hooks that measure spend against them. It also writes a window heartbeat: `scripts/construct/window-heartbeat.mjs` runs on every tool use and records a `window.heartbeat` carrying the window's context and spend into the repository's bus. The `.claude/settings.json` it writes lets the window edit and write files in its own repository, and asks before an edit of `.claude/settings*.json` or `.claude/eddies.json`. When `init` merges into an existing `.claude/settings.json`, it now adds the browser-lab sandbox exclusion as well as the hooks. `attach` adds a `heartbeat` hook to the self-contained window hooks, which writes the same `window.heartbeat` without the gauges. A bus that is absent, or has no events table yet, is left as the hook found it.

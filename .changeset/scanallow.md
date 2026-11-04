---
"mikoshi-construct": patch
---

A fresh `init` allows `WebFetch`, `WebSearch` and `mcp__context7` in `.claude/settings.json`, so the scan role can read documentation under `dontAsk` instead of being refused. A repository that already has `.claude/settings.json` does not get these rules: the merge there takes only hooks and sandbox.

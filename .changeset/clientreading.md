---
'mikoshi-construct': patch
---

The bus now reads a session's stream and transcript through one reading in the client adapter; its events, usage, cost, turns, model, denials and session identity keep their values, and what the client does not report reads null. One thing a user can see: the answer node now looks for a session's transcript under `CLAUDE_CONFIG_DIR` when it is set, as the launch node already did, where it looked only in the home directory, so an answer session resumes there instead of starting fresh.

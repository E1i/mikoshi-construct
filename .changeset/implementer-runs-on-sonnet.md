---
"mikoshi-construct": patch
---

The generated `.claude/agents/implementer.md` runs the implementer with `model: sonnet` instead of `inherit`, so the low-effort rung no longer runs on whatever model the session uses. The architect and harness agents still inherit. The Cursor channel is not affected.

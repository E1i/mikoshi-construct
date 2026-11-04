---
"mikoshi-construct": patch
---

`miko:exit` now accepts a window-core version change as a stop condition: when a session the `pnpm miko` loop started loaded an older version than `architecture/window-core.md` now carries, it ends with reason `core` given a fresh handoff, and the loop starts the next session on the new core, so the owner no longer has to type `/exit`. A session outside the loop is not stopped by it.

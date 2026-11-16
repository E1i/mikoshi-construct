---
'mikoshi-construct': patch
---

Board session cards: the grid's minimum column width is now 20rem, and no card overflows its column. The terminal block is six lines tall and scrolls inside itself. The header slot counter counts live sessions, so three live launch runners read `launch 3/3`. A runner card shows its model, e.g. `(SONNET 5.5)`, taken from the session heartbeat. The Miko panel shows the window model, the window-core version the loop loaded, the handoff STATUS and size, and the skills the window session loaded. Its crawlers cell reads the window's live background subagents. `miko:watch` now writes them into `window.heartbeat` as `crawlers` (id, kind, description, started_at, state, ctx, spent), next to `skills` and `core`. The cell shows `LIVE · N`, one row per crawler marked CRAWLING or IDLE with its CTX and SPENT, and a FLATLINED stamp when none is live.

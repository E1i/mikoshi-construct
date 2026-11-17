---
'mikoshi-construct': patch
---

The bus's HTML board carries only live cards and the cards merged in the last 24 hours: `board-data.js` drops from about 13.5 MB to about 13 KB. `board.html` is a data-free shell written only when its template changes, and `board-data.js` is rewritten every 10 seconds by a board timer that runs outside the bus tick on a read-only connection, so the board neither waits for a slow tick nor slows it. History leaves the page: `pnpm board --all` writes `board-history.html` beside `bus.db` on demand.

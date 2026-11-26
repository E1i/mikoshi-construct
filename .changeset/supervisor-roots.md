---
'mikoshi-construct': patch
---

The supervisor processes `scripts/supervisor/run.ts`, `review-bg.ts`, `supervisor.ts`, `reducer-thread.ts` and `launchd/install.ts` become composition roots of the module graph, and `supervisor.ts` leaves the session contract. `signal` moves from `supervisor.ts` to `signal-sent.ts`, and `stillSilent` (with `Judged`) to `heartbeat.ts`, so `stalled-sessions.ts` and `window/board.ts` import a session file rather than a root. The ratchet rows `boundary:session->board`, `session->composition-root`, `session->node-review` and `session->pr-record` fall to none, `boundary:session->window` from 5 to 2, and `lines:scripts/supervisor/supervisor.ts` from 1135 to 1103; no row grows.

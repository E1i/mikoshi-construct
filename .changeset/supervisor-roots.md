---
'mikoshi-construct': patch
---

The supervisor processes `scripts/supervisor/run.ts`, `review-bg.ts`, `supervisor.ts`, `reducer-thread.ts` and `launchd/install.ts` become composition roots of the module graph, and `supervisor.ts` leaves the session contract. `signal` moves from `supervisor.ts` to `signal-sent.ts`, and `stillSilent` (with `Judged`) to `heartbeat.ts`, so `stalled-sessions.ts` and `window/board.ts` import a session file rather than a root. `LivenessJudge`, the owner of the concepts `pid-liveness` and `live-session`, moves with `expectedRunning`, `judgeSilent`, `currentLifeBeats` and `recordJudged` into the session file `liveness-judge.ts`, with the card transitions injected by `supervisor.ts`. The ratchet rows `boundary:session->board`, `session->composition-root`, `session->node-review` and `session->pr-record` fall to none, `boundary:session->window` from 5 to 2, and `lines:scripts/supervisor/supervisor.ts` from 1135 to 1013; no row grows.

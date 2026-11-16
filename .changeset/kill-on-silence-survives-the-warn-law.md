---
'mikoshi-construct': patch
---

The bus no longer kills a live session for being silent or over time. A launch session with no heartbeat for 20 minutes, or one running past its time limit, now gets `board.alarm` and `session.stalled` once per stall and keeps running. The same applies to a review session that stalls once or twice on a head, and to one that reaches its 20-minute ceiling. The review client is no longer spawned with a SIGKILL timeout, and a review session that has written its verdict is no longer SIGKILLed: the worker waits for it to end on its own. The owner's stop (`pnpm bus:request owner.stop --card <N>`) still ends a launch session. A review session that stalls twice keeps its task, which is no longer withdrawn under it. Card sessions start with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, so a command that hits its Bash timeout is stopped instead of moving to the background and holding the run open.

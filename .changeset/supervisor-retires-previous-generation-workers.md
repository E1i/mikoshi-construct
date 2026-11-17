---
'mikoshi-construct': patch
---

On start, the supervisor retires the heartbeat rows of its previous generation whose processes are gone: a row that last beat before this supervisor started and whose name carries a pid that no longer lives (such as `miko:<pid>` of an earlier window) is marked `retired`, never deleted. The board's BUS WORKERS no longer counts a retired row, and a fresh beat under the same name counts again.

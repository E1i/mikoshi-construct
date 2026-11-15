---
'mikoshi-construct': patch
---

The board now shows how long each live launch, answer and review session has run and what it is doing: the current tool or command and how long it has run. With no reliable source for a wait, the row says the wait has an unknown reason and gives its duration. A queued task shows which cards it stands behind and how long it has waited. The supervisor computes an expected round time from the bus measurements, by size and contour. With too few samples it says not enough data and raises nothing; past the expected time it raises `board.alarm` with reason `over_time` and the current action, and the session runs on. `pnpm owner:answer #N "stop: <reason>"` stops the card's live session through `owner.stop` and records the stop with the reason; the tree is kept. `pnpm owner:session #N` prints what a card's session is doing now, its last actions with their times and its long gaps.

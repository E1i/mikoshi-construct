---
"mikoshi-construct": patch
---

`construct board` groups the backlog by the parking lane a card was admitted to or moved to with `intake --move`, not by the launch slot the bus gave it. The launch slot is kept apart as `slot-N` and is never named a lane, and empty `lane-1…N` headings are no longer printed. Every wait under "waits for you" now ends with a ready command and who runs it: the owner runs `gh pr merge` for a merge wait and `pnpm decisions:add` for a decision, and the window runs the `pnpm intake` and `pnpm bus:request` commands a wait names. Each open plan shows a text progress bar. When the bus holds live cards but no open plan, the board prints `plan not registered` with the command that registers one, and an empty flow names the command that admits a card. The bus also closes a wait that asked the window to amend a card as soon as that card is admitted again.

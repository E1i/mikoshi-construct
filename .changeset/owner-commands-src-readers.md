---
'mikoshi-construct': patch
---

`board`, `doctor` and `intake` take the command lines they print from `scripts/core/owner-commands.ts`: the board's decision, plan and admit hints, the doctor's `construct sync --apply`, ghost-protocol and handoff lines, its `construct init` hint, and the intake numbering reason come from the owner, and their rows leave the pending table. The text each prints is unchanged.

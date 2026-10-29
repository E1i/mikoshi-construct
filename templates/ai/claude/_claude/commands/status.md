---
description: Show where the tasks stand — construct board as it prints, then what changed since the last status and what waits for the owner.
---

Run `construct board` (or `npx mikoshi-construct board`) from the repository root (add `--dir <repository>` only when
the owner names another one) and show its output exactly as printed, in a code block, with
nothing removed or reworded.

Then write one or two lines, no more:

- what changed since the previous status in this conversation, read from the two board outputs rather than from memory
  (a task that appeared, moved stage, went red or merged); if there is no previous status in this conversation, say so;
- what waits for the owner: each pull request whose NEXT is the owner's merge or approval, by number.

If `construct board` refuses or fails, show its message as printed and stop; do not reconstruct the state from the session.

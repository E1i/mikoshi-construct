---
description: Show where the tasks stand — the text reading pnpm board prints, then what changed since the last status and what waits for the owner.
---

Run `pnpm board` with no flag from the repository root. It prints a short text reading of the bus — the release
progress, the `waits for you` line, the cards by stage, the live backlog by lane and the services — sized for a
window's context. Show that output exactly as printed, in a code block, with nothing removed or reworded. Never run
`pnpm board --html` for a status: it prints the HTML page, megabytes long, which is for a browser; `pnpm board --json`
is for a script.

Then write one or two lines, no more:

- what changed since the previous status in this conversation, read from the two board outputs rather than from memory
  (a task that appeared, moved stage, went red or merged); if there is no previous status in this conversation, say so;
- what waits for the owner: each pull request the `waits for you` line names for the owner's merge or approval, by
  number.

If `pnpm board` refuses or fails, show its message as printed and stop; do not reconstruct the state from the session.

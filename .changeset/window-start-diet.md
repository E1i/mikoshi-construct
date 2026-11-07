---
'mikoshi-construct': patch
---

`pnpm miko` starts the window on a diet: `--setting-sources project,local`, `--strict-mcp-config` with an empty MCP config of its own and `--disallowedTools` for the five schemas the window never calls (Artifact, Workflow, AskUserQuestion, ScheduleWakeup, ReportFindings); card sessions launch as before. `pnpm board --json --live` prints only the live cards, and is the window's start reading of the board. `window-core` points at the section of `window.md` with its line range. `pnpm exec tsx scripts/window/start-context.ts --last` reads the last window's first-turn context and its context at the first `miko:watch` against 45k and 70k.

---
"mikoshi-construct": patch
---

`miko exit` now finds the Eddies context threshold when it runs from a shell that does not set `CLAUDE_PROJECT_DIR`: it reads `.claude/eddies.json` of the directory it runs in, not of the installed package. A window under the `pnpm miko` loop that is past the threshold, with a fresh handoff ending `STATUS: CONTINUE`, now exits and is restarted instead of being refused with "not at a stop condition".

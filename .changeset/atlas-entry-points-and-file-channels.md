---
"mikoshi-construct": minor
---

cli: `construct atlas` shows the entry points of a repository — its `package.json` scripts, workflow steps and Claude Code hooks — each linked to the files its command names, and the files one module writes through `node:fs` and another reads, with `path:line` on both sides; the Engram records them as `runs`, `writes` and `reads` relations beside `imports` and `calls`

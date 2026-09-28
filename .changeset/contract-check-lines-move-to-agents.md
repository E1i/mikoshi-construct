---
"mikoshi-construct": minor
---

templates: the `/implement` ladder now reads the `Contract paths:` and `Contract check:` lines from the repository's AGENTS.md, never from CLAUDE.md — a line found only in CLAUDE.md makes the build refuse, naming it and saying it moved to AGENTS.md. When a repository declares a `Contract check:` line, the ladder runs it after the harness command passes and a red or unreported check ends the rung `contract check failed`, never `done`.

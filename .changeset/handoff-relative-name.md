---
"mikoshi-construct": patch
---

factory: `miko handoff write` and `miko handoff check` resolve a relative handoff name against the repository's handoff directory — `~/.construct/<owner>--<repo>/handoff` in a repository other than mikoshi-construct, `~/.construct/handoff` in a mikoshi-construct checkout, `CONSTRUCT_HANDOFF_DIR` when it is set — and the first handoff in a new repository is created with its directory. Before, `miko handoff write miko.md <draft>` from the root of a fresh repository resolved `miko.md` against the working directory and refused it as not this session's handoff, so the window in a new repository could not write its first handoff.

---
'mikoshi-construct': patch
---

The `intake` skill that `init` and `attach` write into `.claude/skills/intake/SKILL.md` no longer names the removed `--journal` option or its `~/.construct/handoff/ghosts.jsonl` default: it says `construct intake` checks cards against the closed and merged cards the bus records, and records each parked card in the bus as one `card.admitted`.

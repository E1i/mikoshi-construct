---
"mikoshi-construct": minor
---

cli: `construct intake` and `construct mutate judge --card` no longer write `~/.construct/handoff/ghosts.jsonl`; intake records each card only through the bus a caller wires in, and `mutate judge --card` records its `mutation-judged` line in that bus and is refused when none is wired, so its `--journal` flag is gone

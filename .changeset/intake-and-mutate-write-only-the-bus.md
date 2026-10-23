---
"mikoshi-construct": minor
---

Breaking: `construct mutate judge` drops its `--journal` flag, and `contract/surface.json` no longer records it; before 1.0 a removed flag is a minor bump, as `contract:bump` requires. A script that passed `--journal` is now refused as passing an unknown flag; drop the flag. `construct intake` and `construct mutate judge --card` no longer write `~/.construct/handoff/ghosts.jsonl`: intake records each card only through the bus a caller wires in, and `mutate judge --card` records its `mutation-judged` line in that bus and is refused when none is wired.

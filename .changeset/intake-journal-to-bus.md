---
'mikoshi-construct': minor
---

Breaking: `construct intake` drops its `--journal` option and its `~/.construct/handoff/ghosts.jsonl` default. Closed and merged cards, numbers and recorded admissions are read from the bus the caller wires in alone; with no bus wired, a `#<id>` in `depends` or `blocks` is kept and marked unclear unless it is parked. `defaultWindowJournal` and `WINDOW_JOURNAL_FILE` are no longer exported.

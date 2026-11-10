---
'mikoshi-construct': minor
---

`construct run-record` records one `/implement` ladder run: where no bus is wired for the directory it appends one line to `.construct/runs.jsonl`; where one is, the published CLI writes nothing to the bus and refuses, and `construct-intake run-record` appends one `ladder.run` event, deduplicated by the record. A record that does not parse or names a field the ledger does not declare is refused with exit `2` and nothing is written. The ladder's supervisor, watch and handoff read the run from the same source, so no reader stays on a file nobody writes.

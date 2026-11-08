---
'mikoshi-construct': patch
---

Under an active window shard, the answer node no longer stops an answer whose changes outside the card's touches all stay within the card's concept: a direct importer of a touched or created file, a file under a test root, or a test-keyed record such as `scripts/ci/sandbox-failing.jsonl`. The bus commits and pushes the answer and records `scope.widened` with those paths in the same transaction as `card.answered`. A path under `.claude/`, an owner path, an R1 path, or any other file still stops the answer as before, and without a window shard nothing changes.

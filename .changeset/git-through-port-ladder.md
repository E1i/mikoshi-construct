---
'mikoshi-construct': patch
---

The ladder (`scripts/ladder/`) runs git only through the port `scripts/ports/git.ts`, which now holds a process adapter and an in-memory one, and a test fails on a git call in the ladder outside it. The git overlaps the factory counts drop from 72 to 53. A git error inside the ladder supervisor now carries git's stderr in its message instead of printing it to the supervisor log.

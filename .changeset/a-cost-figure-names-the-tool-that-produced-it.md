---
"mikoshi-construct": minor
---

cli+templates: Every `construct cost` report names the version of the CLI that produced it — before
the numbers in the text register, as `version` in `--json` — and the `/implement` instructions now
require every figure in the closing usage line to name what measured it: the Workflow tool's own
accounting, or `construct cost` at the version that command reports. A whole session of published
cost figures came from a binary that reported `0.1.1` and, on inspection of the bundle itself,
predates the response-deduplication fix — while the sources they were quoted against are at `0.8.0`.
Nothing in any of those numbers said so, and the version the binary reports turned out not to be
enough on its own to place it. A hypothesis already records what tree it was read from; a cost figure
recorded nothing, and that asymmetry is what this closes.

No figure changes: the arithmetic is untouched and pinned by a test, and the two counting methods
that are known to disagree remain unreconciled — while they are, provenance is what lets a reader see
which of them a number came from.

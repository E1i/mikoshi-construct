---
"mikoshi-construct": patch
---

`construct intake` and `construct intake --admit` now refuse a card whose touches put a `/**` mask over a directory of the factory's shared code (`scripts/bus`, `scripts/core`, `src/commands/board` and the rest of one explicit list). Masks over `tests/**`, `scripts/tests/**`, `.changeset/**` and a new directory named in `creates` are still accepted. The refusal names the mask and, when the contour map lists files under that directory, proposes them in its place.

---
"mikoshi-construct": minor
---

cli: when `construct intake` proposes a risk seam, a test now goes into the slice of the higher-risk code it checks. This covers tests under `tests/` and tests under `scripts/tests/<area>/`, which match only code under `scripts/`. A test matches when its file name or one of its directories under the test root matches a path segment of that code. The test name may also be that segment followed by `-` and more. The top-level directory of the code path and `commands` never count as a match. Before this, every test went into the lower slice, where it could not fail on the code it checks. Intake also refuses a card whose task text has its own `slice:` lines when a seam proposes different slices, unless a person kept the card whole. The reason it gives names both ways to settle it

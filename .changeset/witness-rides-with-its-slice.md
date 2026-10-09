---
"mikoshi-construct": minor
---

cli: when `construct intake` proposes a risk seam, a test under `tests/` whose name matches a path of the higher-risk code now goes into that code's slice. Before this, every test went into the lower slice, where it could not fail on the code it checks. Intake also refuses a card whose task text has its own `slice:` lines when a seam proposes different slices, and the reason it gives names both ways to settle it

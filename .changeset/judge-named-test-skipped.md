---
"mikoshi-construct": minor
---

cli: `construct mutate judge` now refuses a report in which the test named in the prediction was skipped, even when other tests passed, because a skipped test cannot fail.

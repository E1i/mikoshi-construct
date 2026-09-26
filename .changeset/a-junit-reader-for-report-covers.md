---
"mikoshi-construct": minor
---

A `report-covers` or `report-misses` fact carries a `format`: `vitest-json` (the default, read when
`format` is absent) or `junit-xml`. Point a `junit-xml` fact's `path` at a report produced by
`pytest -o junit_family=xunit1 --junitxml=<path>`; the reader takes a testcase's repository path only
from its `file` attribute, reads a `<skipped>` testcase as not run and `<failure>`/`<error>` as run,
and yields `unknown` coverage rather than throwing on a file it cannot parse. The model format goes to
`modelVersion` 3.

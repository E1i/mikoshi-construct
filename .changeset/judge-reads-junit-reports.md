---
"mikoshi-construct": patch
---

cli: `mutate judge` takes `--format vitest-json` (the default) or `--format junit-xml`, so a JUnit
XML report from any runner can stand in for Vitest's json reporter. A JUnit report is refused,
naming the missing run start time, when none of its `<testsuite>` elements carries a `timestamp`
attribute — the file's own modification time is never used as a stand-in.

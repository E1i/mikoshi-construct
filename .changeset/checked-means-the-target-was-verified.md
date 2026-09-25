---
"mikoshi-construct": minor
---

Breaking: `doctor --json` `harness.state` gains `does-not-cover`, and `checked` changes meaning (decision 0033). It is now the projection of the verification stage of the discovery-written claim `harness-covers-target`: `checked` only when a Vitest JSON report lists a file of the repository's own verification surface as executed, `does-not-cover` when a complete, fresh report shows none of it ran, `unknown` otherwise. A consumer that read `checked` as "the command is a package script" now gets `unknown` on the same repository; `harnessProblems` and `ok` are unchanged. The model format goes to `modelVersion` 2 with the fact kinds `file-lacks`, `report-covers` and `report-misses`. `construct graph` draws report-backed entries in a fixed `runtime-report` class and never reads a report.

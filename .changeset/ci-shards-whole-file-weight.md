---
'mikoshi-construct': patch
---

A vitest shard weight is now a test file's whole wall time in its shard: environment, prepare, setup, import and collect, and its tests. Before, it was the JSON report's test span, which leaves out everything before the first test, so files heavy in imports or setup were underweighted and piled into one shard. CI's report-merge step runs `scripts/ci/file-weights-reporter.ts`, which writes `file-weights.json` beside `vitest.json` in the `vitest-report` artifact. `pnpm test:weights --from main` and `--check` read only that file. They skip a main run whose artifact predates it, and when no run carries it they leave the table as it is and print a line saying so.

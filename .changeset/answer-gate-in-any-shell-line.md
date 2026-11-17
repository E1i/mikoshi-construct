---
'mikoshi-construct': patch
---

The answer node now recognises a gate command inside any shell line, not only in its declared form. A line that starts with `cd <path>;`, `cd <path> &&` or `set -o pipefail;`, that spells the gate with `pnpm --dir <tree>` or `run`, or that merges stderr and pipes into `tail` is a gate run, and the round reaches a gate decision instead of `answer_failed`. A pipe's exit is not the gate's exit, so a piped gate run is recorded as red when its output shows the gate failing (`ELIFECYCLE`, `ERR_PNPM_`, `Command failed with exit code N`), and otherwise as a gate that could not run. The exception is a line that sets `pipefail`, which carries the gate's own exit. A gate run in the background, a gate chained to another command, and a line that only mentions the gate are still not recorded as gate runs.

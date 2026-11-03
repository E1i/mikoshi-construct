---
"mikoshi-construct": patch
---

The pre-push run in a card session now runs the tests named on the sandbox list instead of filtering them out by name. A listed test that still fails does not block the push; a listed test that passes turns the run red with a `stale:` line naming its entry in `scripts/ci/sandbox-failing.jsonl`, so the list cannot drift silently until a card touches the selector. Files listed whole are still left out. The two entries of `scripts/tests/scratch/run-root.test.ts` that now pass are gone from the list.

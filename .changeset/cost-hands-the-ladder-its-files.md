---
'mikoshi-construct': patch
---

Internal: the `ladder` module takes the step-accounting files of `src/commands/cost/` (`bus`, `cheap`, `claude-code`, `expect`, `ledger`, `sample`, `source`, `step-cache`, `steps`, `turns`, `usage`) and `src/commands/run-record.ts` from `cost` and `release`. `stepsOfRepository` gets a ladder home in `step-cache.ts`, and `scripts/ladder/expect-sample.ts` and `scripts/ladder/expect.ts` import the files they read instead of the cost barrel. The ratchet rows `boundary:ladder->cost`, `ladder->release`, `node-close->cost`, `release->cost` and `session->cost` are removed. Behaviour is unchanged.

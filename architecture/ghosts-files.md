# Files under scripts/ghosts

Every file under `scripts/ghosts/**` has one row here, and its kind is `ghosts` or `plain`. `ghosts` is the Ghost
launcher and every file whose output the ladder, an approval, a merge or a security decision trusts; `plain` is a
file that only reads or prints. `scripts/shift/merge.ts`, `scripts/shift/parking.ts` and the preflight's P4
(`scripts/ghosts/preflight-static.ts`) read this table, and no other file holds a copy. A card that creates a file
under `scripts/ghosts/` declares it in `creates:` with its kind, as `scripts/ghosts/<name>.ts (plain)`, and its pull
request adds the row. `scripts/tests/shredder/owner-merges.test.ts` is red while a file has no row or a row names no
file. This file is not owner-merged: who merges is decided in [owner-merges.md](owner-merges.md).

| file | kind |
|---|---|
| `scripts/ghosts/agreed.ts` | ghosts |
| `scripts/ghosts/approval.ts` | ghosts |
| `scripts/ghosts/approve.ts` | ghosts |
| `scripts/ghosts/args-chain.ts` | ghosts |
| `scripts/ghosts/cheap-expect.ts` | plain |
| `scripts/ghosts/cleanup.ts` | ghosts |
| `scripts/ghosts/cloud-key.ts` | ghosts |
| `scripts/ghosts/cloud-start.ts` | ghosts |
| `scripts/ghosts/entry.ts` | plain |
| `scripts/ghosts/every.ts` | plain |
| `scripts/ghosts/expect-sample.ts` | plain |
| `scripts/ghosts/expect.ts` | plain |
| `scripts/ghosts/handoff-check.ts` | plain |
| `scripts/ghosts/hash.ts` | ghosts |
| `scripts/ghosts/install.ts` | ghosts |
| `scripts/ghosts/journal.ts` | ghosts |
| `scripts/ghosts/launch.ts` | ghosts |
| `scripts/ghosts/ledger.ts` | plain |
| `scripts/ghosts/matrix.ts` | plain |
| `scripts/ghosts/preflight-static.ts` | ghosts |
| `scripts/ghosts/preflight-trees.ts` | ghosts |
| `scripts/ghosts/preflight-witnesses.ts` | ghosts |
| `scripts/ghosts/preflight.ts` | ghosts |
| `scripts/ghosts/regenerated.ts` | ghosts |
| `scripts/ghosts/result.ts` | plain |
| `scripts/ghosts/review-carry.ts` | ghosts |
| `scripts/ghosts/role-sample.ts` | plain |
| `scripts/ghosts/role.ts` | plain |
| `scripts/ghosts/session.ts` | ghosts |
| `scripts/ghosts/sketch.ts` | ghosts |
| `scripts/ghosts/status.ts` | plain |
| `scripts/ghosts/supersede.ts` | ghosts |
| `scripts/ghosts/supervise.ts` | ghosts |
| `scripts/ghosts/task-close.ts` | ghosts |
| `scripts/ghosts/task-merged.ts` | ghosts |
| `scripts/ghosts/task-start.ts` | ghosts |
| `scripts/ghosts/tasks.ts` | ghosts |
| `scripts/ghosts/verdict.ts` | ghosts |
| `scripts/ghosts/watch-ledger.ts` | plain |
| `scripts/ghosts/watch-process.ts` | plain |
| `scripts/ghosts/watch-report.ts` | plain |
| `scripts/ghosts/watch.ts` | plain |

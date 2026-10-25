# Files of the former ghosts folder

Every file under `scripts/ladder/**` and every other file of the former ghosts folder (`FACTORY_FORMER_FOLDERS.ghosts`) has one row here, and its kind is `ghosts` or `plain`. `ghosts` is the Ghost
launcher and every file whose output the ladder, an approval, a merge or a security decision trusts; `plain` is a
file that only reads or prints. `scripts/intake/parking.ts` and the preflight's P4
(`scripts/ladder/preflight-static.ts`) read this table, and no other file holds a copy. A card that creates a file
under `scripts/ladder/` declares it in `creates:` with its kind, as `scripts/ladder/<name>.ts (plain)`, and its pull
request adds the row. `scripts/tests/shredder/owner-merges.test.ts` is red while a file has no row or a row names no
file. This file is not owner-merged: who merges is decided in [owner-merges.md](owner-merges.md).

| file | kind |
|---|---|
| `scripts/ladder/agreed.ts` | ghosts |
| `scripts/ladder/approval.ts` | ghosts |
| `scripts/ladder/approve.ts` | ghosts |
| `scripts/ladder/args-chain.ts` | ghosts |
| `scripts/ladder/brief-finish-cli.ts` | plain |
| `scripts/ladder/brief-finish.ts` | plain |
| `scripts/ladder/cleanup.ts` | ghosts |
| `scripts/ladder/cloud-key.ts` | ghosts |
| `scripts/core/entry.ts` | plain |
| `scripts/core/every.ts` | plain |
| `scripts/ladder/expect-sample.ts` | plain |
| `scripts/ladder/expect.ts` | plain |
| `scripts/window/handoff-check.ts` | plain |
| `scripts/ladder/handoff.ts` | ghosts |
| `scripts/ladder/hash.ts` | ghosts |
| `scripts/ladder/install.ts` | ghosts |
| `scripts/core/journal.ts` | ghosts |
| `scripts/ladder/ladder-starter.ts` | plain |
| `scripts/ladder/ladder.ts` | plain |
| `scripts/ladder/launch.ts` | ghosts |
| `scripts/ladder/ledger.ts` | plain |
| `scripts/ladder/matrix.ts` | plain |
| `scripts/ladder/morse-approve.ts` | ghosts |
| `scripts/ladder/policy.ts` | plain |
| `scripts/ladder/preflight-static.ts` | ghosts |
| `scripts/ladder/preflight.ts` | ghosts |
| `scripts/ladder/regenerated.ts` | ghosts |
| `scripts/nodes/update/review-carry.ts` | ghosts |
| `scripts/ladder/role-sample.ts` | plain |
| `scripts/ladder/roles.ts` | plain |
| `scripts/ladder/role.ts` | plain |
| `scripts/ladder/sketch.ts` | ghosts |
| `scripts/ladder/status.ts` | plain |
| `scripts/ladder/supersede.ts` | ghosts |
| `scripts/ladder/supervise.ts` | ghosts |
| `scripts/nodes/close/task-close.ts` | ghosts |
| `scripts/nodes/close/task-merged.ts` | ghosts |
| `scripts/ports/task-start.ts` | ghosts |
| `scripts/core/tasks.ts` | ghosts |
| `scripts/ladder/tree.ts` | ghosts |
| `scripts/ladder/verdict.ts` | ghosts |
| `scripts/ladder/watch-ledger.ts` | plain |
| `scripts/ladder/watch-process.ts` | plain |
| `scripts/ladder/watch-report.ts` | plain |
| `scripts/ladder/watch.ts` | plain |
| `scripts/ladder/window.ts` | plain |

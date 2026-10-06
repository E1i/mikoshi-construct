# Owner-merged kinds (data)

**Only Eli edits this file.** A window reads it to decide whether a pull request is armed for auto-merge or reported as
"ready at sha X" for Eli to merge. It is an authority axis, not a task class. Nothing here is inferred: a kind is on
this list because Eli put it here.

Written by window A on 2026-09-27 at Eli's instruction, copying the list Eli settled on 2026-09-27. The paths column and the
kind `ghosts` were added the same day, also at Eli's instruction, with Eli's globs. Moved unchanged into the repository on
2026-09-28 at Eli's instruction. From now on, only Eli changes it. The kind `agents-md` is Eli's decision of 2026-09-28,
which was not written here then; window A added it on 2026-09-29 at Eli's instruction. The glob `templates/attach/**` under `own-instructions` is Eli's decision of 2026-09-30, added by window A
at Eli's instruction. On 2026-10-04, at Eli's instruction (task #35), the coordinating window replaced the glob
`scripts/ghosts/**` of the kind `ghosts` with Eli's 13 paths, added the plain list below with Eli's 15 paths, and added
`architecture/owner-merges.md` to `own-instructions`: the file that decides who merges is never auto-merged. On 2026-10-04, at Eli's
instruction (task #167), the coordinating window added `scripts/ghosts/role-sample.ts` to the plain list. On 2026-10-04, at Eli's instruction (task #178), the coordinating window added
the shift's merge rule (`header.md`) and the script that applies it (`merge.ts`), both under `scripts/shift/`, to `own-instructions`. The same day, at Eli's instruction (task #178), it added
`scripts/shredder/reader.ts`, `scripts/shredder/authority.ts` and `scripts/shredder/glob.ts` to `own-instructions`: the merge
decision is taken on their output. On 2026-10-04, at Eli's instruction (task #190), the coordinating window added `scripts/shift/shift.ts`
to `own-instructions`: the shift runner now runs that merge decision itself after a session exits. On 2026-10-05, at Eli's instruction (task #574), the coordinating window added `scripts/ghosts/task-merged.ts` to `ghosts`:
`task-start.ts` starts or refuses a card on the merge lines it writes; and `scripts/shift/parking.ts` to `own-instructions`: the shift's
choice of a card now reads those merge lines. On 2026-10-06, at Eli's instruction (task #551), the coordinating window added
`scripts/ghosts/supervise.ts` to `ghosts`: the launcher's work moved into it. The same day, at Eli's instruction (task #553), it added
`scripts/ghosts/regenerated.ts` and `scripts/ghosts/review-carry.ts` to `ghosts`: the launcher accepts a regenerated sketch in place of
an approval, and `ghosts:verdict` carries a review to a new head, on their output. The same day, at Eli's instruction (task #570), it added
`scripts/ghosts/preflight.ts`, `scripts/ghosts/preflight-static.ts`, `scripts/ghosts/preflight-trees.ts` and
`scripts/ghosts/preflight-witnesses.ts` to `ghosts`: `ghosts:hash` prints the approval hash only when their preflight is green. The same
day, at Eli's instruction (task #552), it added `scripts/ghosts/supersede.ts` to `ghosts`: cleanup releases a run a re-approved brief
superseded, on its output. On 2026-10-06, at Eli's instruction (task #602), it recorded that MORSE approves an R2–R4 brief
([0053](decisions/0053-morse-approves-a-brief-the-risk-matrix-does-not-reserve-for-the-owner.md)): that changes who approves a
brief, not who merges, and a pull request that changes `scripts/ghosts/approval.ts`, `hash.ts` or `launch.ts` is still of the kind `ghosts`. The same day, at Eli's instruction (task #604), it added `scripts/ghosts/approve.ts` to `ghosts`:
`pnpm approve` writes the approval line the launcher trusts. The same day, at Eli's instruction (task #617), it moved
`scripts/ghosts/task-close.ts` from the plain list to `ghosts`: it now decides whether a task closes with `mutation` and
whether a verification word its shift report contradicts is written.

Rule of application (Eli, 2026-09-27, written by window A at Eli's instruction): **Eli merges a pull request if at least
one file it changes matches at least one glob of a kind; an empty cell means the kind is not checked by paths.** (`release`
is matched by its title.)

| kind | paths (globs) | what it covers | example |
|---|---|---|---|
| release | — (matched by title: «chore: version packages») | version pull requests | PR #259, PR #265, PR #277 |
| own-instructions | `.claude/**`, `scripts/construct/**`, `templates/ai/claude/**`, `templates/attach/**`, `architecture/owner-merges.md`, `scripts/shift/header.md`, `scripts/shift/merge.ts`, `scripts/shift/parking.ts`, `scripts/shift/shift.ts`, `scripts/shredder/reader.ts`, `scripts/shredder/authority.ts`, `scripts/shredder/glob.ts` | the agent's own working instructions: the implement skill, the agent files (`implementer.md`, `harness.md`, `architect.md`), the ladder script, `check-acceptance` — in the repository or in `templates/ai/` — and what `attach` hands the agent from `templates/attach/` | PR #244, PR #282; issues #257, #269, #271 |
| release-workflow | `.github/workflows/release*.yml` | `.github/workflows/release.yml` and what it runs for publishing | — |
| security-invariants | `architecture/security-invariants.md`, `templates/**/security-invariants.md` | `architecture/security-invariants.md` and the template copies | — |
| new-write-path | — (not checked by paths: decided by the owner) | a new path that `init` or `attach` writes: a new carrier, a new baseline file, anything that grows `ATTACH_CARRIERS`, `paths.attach.writes` or `paths.init.*` | PR #218 |
| ghosts | `scripts/ghosts/agreed.ts`, `scripts/ghosts/approval.ts`, `scripts/ghosts/approve.ts`, `scripts/ghosts/args-chain.ts`, `scripts/ghosts/cleanup.ts`, `scripts/ghosts/hash.ts`, `scripts/ghosts/install.ts`, `scripts/ghosts/journal.ts`, `scripts/ghosts/launch.ts`, `scripts/ghosts/preflight-static.ts`, `scripts/ghosts/preflight-trees.ts`, `scripts/ghosts/preflight-witnesses.ts`, `scripts/ghosts/preflight.ts`, `scripts/ghosts/regenerated.ts`, `scripts/ghosts/review-carry.ts`, `scripts/ghosts/session.ts`, `scripts/ghosts/sketch.ts`, `scripts/ghosts/supersede.ts`, `scripts/ghosts/supervise.ts`, `scripts/ghosts/task-close.ts`, `scripts/ghosts/task-start.ts`, `scripts/ghosts/task-merged.ts`, `scripts/ghosts/tasks.ts`, `scripts/ghosts/verdict.ts` | the Ghost launcher and what changes the ladder, approval, merge or security: launch, approval, hash, verdict, cleanup, and every file whose output one of them trusts with a decision | — |
| agents-md | `AGENTS.md` | this repository's `AGENTS.md`, the rules every agent working here reads | PR #366 |

Everything else is merged through auto-merge by the window that gated it, including `quality`/CI gates and `formats.*`
bumps. Branch protection is a GitHub setting that Eli applies.

Every file under `scripts/ghosts/**` is in exactly one list: a path of the kind `ghosts` above, or a row of the table
below, which the window merges through auto-merge. A new file is merged only once Eli has classified it;
`scripts/tests/shredder/owner-merges.test.ts` is red until then.

| plain | what it does |
|---|---|
| `scripts/ghosts/cheap-expect.ts` | prints the cheap forecast |
| `scripts/ghosts/entry.ts` | builds and reads the entry-card journal line |
| `scripts/ghosts/every.ts` | parses the watch interval |
| `scripts/ghosts/expect-sample.ts` | reads the forecast sample |
| `scripts/ghosts/expect.ts` | parses and prints the expected cost |
| `scripts/ghosts/ledger.ts` | reads and carries `runs.jsonl` lines; cleanup decides what is removed |
| `scripts/ghosts/matrix.ts` | looks up a matrix row for printing |
| `scripts/ghosts/result.ts` | reads the fields of a report |
| `scripts/ghosts/role-sample.ts` | reads role runs from `turns.jsonl` for the forecast |
| `scripts/ghosts/status.ts` | formats the status rows |
| `scripts/ghosts/watch-ledger.ts` | reads the ladder stage for `ghosts:watch` |
| `scripts/ghosts/watch-process.ts` | lists processes for `ghosts:watch` |
| `scripts/ghosts/watch-report.ts` | reads the report age for `ghosts:watch` |
| `scripts/ghosts/watch.ts` | `ghosts:watch` observes and prints |

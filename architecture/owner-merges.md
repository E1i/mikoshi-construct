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
whether a verification word its shift report contradicts is written. On 2026-10-07, at Eli's instruction (task #665), the coordinating window added `scripts/ghosts/cloud-start.ts` to `ghosts`: `task:close` closes a cloud run on the start line it writes. The same day, at Eli's instruction (task #676), it added `scripts/ghosts/handoff-check.ts` to the plain list: it checks a handoff for its mandatory fields, and no merge decision is taken on its output. On 2026-10-08, at Eli's instruction (task #681), it added `scripts/ghosts/cloud-key.ts` to `ghosts`: `CONSTRUCT_CLOUD` decides whether card bodies and roles run locally or in the cloud; and `scripts/ghosts/role.ts` to the plain list: it prints the route a role takes, and no merge decision is taken on its output. On 2026-10-08, at Eli's instruction (task #650), it added `scripts/shift/shard.ts` to `own-instructions`: with a shard the shift arms auto-merge on an owner pull request on its output.
On 2026-10-09, at Eli's instruction (task #753), the coordinating window narrowed the list: it removed `scripts/shift/**` and `scripts/shredder/{reader,authority,glob}.ts` from `own-instructions`, removed the kind `ghosts` and the plain list, and moved the classification of `scripts/ghosts/**` into [ghosts-files.md](ghosts-files.md), which is not owner-merged; it narrowed `.claude/**` to `.claude/agents/**`, `.claude/rules/**`, `.claude/settings*.json`, `.claude/skills/**` and `.claude/commands/**`, folded `agents-md` into `own-instructions`, and added the kind `agent-permissions`.
On 2026-10-09, at Eli's instruction (task #753, answer on PR #690), the coordinating window added `.claude/hooks/**` and `.claude/eddies.json` to `own-instructions`: `eddies.json` holds the agent's limits, and an agent never raises them for itself; `.claude/statusline.sh` stays auto-merged.
On 2026-10-09, at Eli's instruction (task #775), `construct intake` derives a card's decision from this file: a touch that meets a glob of a kind makes the card `owner`, otherwise `auto`. The same day a Ghost wrote the table «Owner by risk» below by card #775, in a form Eli agreed: an R1 card that changes the rules by which a brief is approved is owner by risk. It is no merge kind: a pull request on those paths is merged by Eli because its card says `owner`, not because of its paths, so the classification of `scripts/ghosts/**` stays in [ghosts-files.md](ghosts-files.md).
On 2026-10-11, at Eli's instruction (orders-2026-10-11 §4j item 1, card #845): **`construct intake` makes `owner` every card whose risk is R1 and every card under «Owner by risk», and never rewrites an `owner` decision to `auto`.** A card is `auto` only when it was not `owner` and no touch meets a glob of a kind, a row of «Owner by risk», or risk R1.

Rule of application (Eli, 2026-09-27, written by window A at Eli's instruction): **Eli merges a pull request if at least
one file it changes matches at least one glob of a kind; an empty cell means the kind is not checked by paths.** (`release`
is matched by its title.)

| kind | paths (globs) | what it covers | example |
|---|---|---|---|
| release | — (matched by title: «chore: version packages») | version pull requests | PR #259, PR #265, PR #277 |
| own-instructions | `.claude/agents/**`, `.claude/rules/**`, `.claude/settings*.json`, `.claude/skills/**`, `.claude/commands/**`, `.claude/hooks/**`, `.claude/eddies.json`, `AGENTS.md`, `scripts/construct/**`, `templates/ai/claude/**`, `templates/attach/**`, `architecture/owner-merges.md` | the agents' instructions: the agent files, the rules, the settings, the skills, the commands, the hooks and the agent's limits in `.claude/eddies.json`, this repository's `AGENTS.md`, the ladder script, their templates in `templates/ai/claude/`, what `attach` hands the agent from `templates/attach/`, and this file | PR #244, PR #282, PR #366; issues #257, #269, #271 |
| release-workflow | `.github/workflows/release*.yml` | `.github/workflows/release.yml` and what it runs for publishing | — |
| security-invariants | `architecture/security-invariants.md`, `templates/**/security-invariants.md` | `architecture/security-invariants.md` and the template copies | — |
| agent-permissions | `contract/factory-permissions.json` | the agents' permissions | — |
| new-write-path | — (not checked by paths: decided by the owner) | a new path that `init`, `attach`, `sync` or `detach` writes into another repository: a new carrier, a new baseline file, anything that grows `ATTACH_CARRIERS`, `paths.attach.writes` or `paths.init.*` | PR #218 |

Everything else is merged through auto-merge by the window that gated it, including `quality`/CI gates and `formats.*`
bumps. Branch protection is a GitHub setting that Eli applies.

## Owner by risk

A card whose risk level is at least the row's, and whose touches meet one of its globs, is `owner` (Eli, 2026-10-09, task #775).

| by risk | paths (globs) | what it covers | example |
|---|---|---|---|
| R1 | `scripts/ghosts/hash.ts`, `scripts/ghosts/approve.ts`, `scripts/ghosts/approval.ts`, `architecture/decisions/0053-morse-approves-a-brief-the-risk-matrix-does-not-reserve-for-the-owner.md`, `architecture/decisions/0058-morse-approves-a-brief-of-every-risk.md` | the rules by which a brief is approved: the approval hash, `pnpm approve`, the approval the launcher trusts, and the decision records they cite | #729 |

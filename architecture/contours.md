# Contours: what each hand-over carries

Status: an inventory, not a decision. Read from `origin/main` at `49d70e0` on 2026-09-30. Nothing here
proposes a contract; it records, for every place one contour of the factory hands work to the next,
what carries it, where its shape is written down today, and whether a hash travels with it.

A hand-over is one of three classes:

- **validated** — structured, and a schema or a parser checks it when it is written or read;
- **unvalidated** — structured by convention (JSON or a Markdown table), read with a cast or a regex;
- **prose** — free text one agent or person writes and another reads.

"Hash" means a digest of the thing handed over that the consumer can check. A git revision recorded
beside it is noted as *revision*, because it names a tree, not the input.

## Hand-overs

| # | Contour | Producer → consumer | Carrier | Shape defined where | Class | Hash travels? |
|---|---|---|---|---|---|---|
| 1 | brief → approval | brief agent → owner → `ghosts:launch` | `brief-<task>.md` and `<brief>.approved-sha256` in the handoff directory | `canonicalImplementText`, `checkApproval` in `scripts/ghosts/approval.ts`; `hashBrief` in `scripts/ghosts/hash.ts`; `scripts/tests/ghosts/approval.test.ts`, `hash.test.ts`. Only the `/implement ` line rule and the `Sketch:` line under it (`parseSketch`, `scripts/ghosts/sketch.ts`, `scripts/tests/ghosts/sketch.test.ts`); the body is free text | prose | yes: sha256 of the `/implement` text, which names the sketch's sha, checked by the launcher before it starts |
| 2 | tasks file → launcher | window → `ghosts:launch`, `pnpm board` | `tasks-*.json` | `parseTasksFile` in `scripts/ghosts/tasks.ts` (unknown or missing field refused); `scripts/tests/ghosts/tasks.test.ts` | validated | no; the brief is named by path, its approval is checked separately (#1) |
| 3 | shredder → matrix row | `scripts/shredder/cli.ts --json` → launcher, board | a JSON file named by the tasks file's `matrix` | `Row` in `scripts/shredder/row.ts`, `ShredderOutput` in `scripts/shredder/render.ts`; read by `lookupMatrixRow` in `scripts/ghosts/matrix.ts` through a second type, `MatrixRow`, with `contour: unknown` and a cast | unvalidated | no; no format field either |
| 4 | snapshot → shredder | window, launcher → shredder | `status.md`, briefs, `owner-merges.md` in a snapshot directory | `readSnapshot` and `tableRows` in `scripts/shredder/reader.ts`: Markdown tables parsed by position | unvalidated | no |
| 5 | launcher → session | `ghosts:launch` → the Ghost session | `.construct/implement-agreed.txt` (`writeAgreedText`, `scripts/ghosts/agreed.ts`) and the same text as the session prompt | the approved `/implement` text, verbatim; for a sketch task the worktree is a carrier too, HEAD at `origin/main` with the sketch's tree staged (`addWorktree`, `scripts/ghosts/supervise.ts`) | prose | checked before the write (#1), and the sketch branch's tip against the approved sketch sha before the checkout; nothing beside the file records the hash, and the session does not re-check it |
| 6 | agreed text → args | session → Workflow `implement` | `.construct/implement-args.json`, then passed inline as the Workflow `args` | `buildArgs` in `scripts/construct/check-acceptance.mjs` (refuses a missing section and a witness `bash -n` rejects); `tests/check-acceptance-build.test.ts`, `check-acceptance-verbatim.test.ts`; the ladder refuses an item with no digest (`scripts/construct/implement.workflow`, lines 127–129) | validated | yes: the handle `build --out` prints names `argsSha256`, the sha256 of the file's bytes, and the file carries `agreedSha256`, the approved hash of the text it was built from; the ladder refuses a file whose hash differs (PR #404); per witness `witnessDigests[].sha256` |
| 7 | ladder → agents | `implement.workflow` → implementer, harness, architect | the prompt the script builds (`implementerPrompt`, `harnessPrompt`, `architectPrompt`) | the script's string templates; the runtime also relays the triggering user message above them (see *Records*) | prose | witnesses only: base64 plus sha256 in the harness prompt |
| 8 | agents → ladder | implementer, harness, architect → `implement.workflow` | the agent's returned object | `REPORT`, `VERDICT`, `SPEC` in `scripts/construct/implement.workflow`, checked by the runtime against the schema; field prose in `.claude/agents/implementer.md`, `harness.md`, `architect.md` | validated | yes for witnesses: `ranSha256` must equal the digest (`observedFor`, line 231) |
| 9 | ladder → session | `implement.workflow` → the session that called it | the Workflow result object | the `return { status, attempts, … }` statements of `implement.workflow`; no schema | unvalidated | yes on `done` and `degraded` only: the result names `argsSha256` and `agreedSha256`; every other status carries neither, and the result echoes `acceptance` verbatim |
| 10 | session → ledger row | the session → `construct cost`, `ghosts:launch`, `ghosts:watch`, `pnpm board` | one line of `.construct/runs.jsonl` | `contract/contours/ledger-row.schema.json` (`ledger-row/1.2`, PR #409); step 4 of `.claude/skills/implement/SKILL.md` (prose) writes it; `parseLedgerLine` in `src/commands/cost/ledger.ts` reads it for `construct cost`, `readLadderOutcome` in `scripts/ghosts/ledger.ts` and `readLedgerStage` in `scripts/ghosts/watch-ledger.ts`. Written by hand, L0 ([0003](decisions/0003-run-ledger-stops-at-l0.md)) | validated at one of its readers | optional since `ledger-row/1.1`: `agreedSha256` and `argsSha256`, copied from the build's handle whatever the status, and, since `ledger-row/1.2`, `sketch` (a sha or null, from the handle's `sketch`); `run` joins the row to the runtime's record |
| 11 | runtime → cost | the runtime's session files → `construct cost` | per-agent `.jsonl` and `.meta.json` under the session's `subagents/workflows/` | `SessionLine` in `src/commands/cost/claude-code.ts`, read with a cast; the output's keys are pinned in `contract/surface.json` (`jsonKeys.cost`, `schemaVersion`) | validated on the output side only | no |
| 12 | launcher → journal (task) | `ghosts:launch` → `pnpm board` | `event:task` line in `ghosts.jsonl` | `JournalEntry` and `appendJournalLine` in `scripts/ghosts/journal.ts`; `scripts/tests/ghosts/journal.test.ts`; read by `readJournal` in `scripts/board/handoff.ts` as `TaskEvent`, a cast | unvalidated | yes: `agreedSha256`, the approved hash, on every line; `argsSha256`, the sha256 of the session's args file bytes, only when the file carries that `agreedSha256` and the session's new ledger row names those bytes (`tiedArgsSha256`, `scripts/ghosts/args-chain.ts`), `null` otherwise; revision: `baseSha`, and `sketch`, the sha or `null` |
| 13 | launcher → status row | `ghosts:launch`, through the supervisor it detaches (`scripts/ghosts/supervise.ts`) → board, shredder, `ghosts:watch` | the `ghost-<id>` row of `status.md`; a writing row's sixth cell is `/implement <brief>, supervisor <pid>, session <id>` | `scripts/ghosts/status.ts` (refuses a file with no window table); read by cell position in `scripts/board/handoff.ts` and `scripts/shredder/reader.ts` | unvalidated | no |
| 14 | session stream → launcher | the Ghost session's stdout → `ghosts:launch`, `ghosts:watch` | `ghost-<id>.jsonl` | the runtime's stream format; `readResultFields` in `scripts/ghosts/result.ts`, `lastToolName` in `scripts/ghosts/watch-report.ts`, read field by field | unvalidated | no |
| 15 | review → report | review agent → window | the agent's final message | `.claude/agents/review.md` fixes the first line (`[review:<task>]`) and nothing after it | prose | no |
| 16 | report → verdict | review agent's `review-<task>.verdict.json` → `pnpm ghosts:verdict` → `pnpm board` | `event:review` line in `ghosts.jsonl`, appended by `ghosts:verdict` (a line written by hand before it carries no `file`) | `contract/contours/review-verdict.schema.json`; `scripts/ghosts/verdict.ts` checks the verdict against it, its `tree` against the pull request's head commit, `report.sha256`, the report's `[review:<task>]` line and `brief.sha256` against `.approved-sha256`, and writes nothing on a fault; `readJournal` in `scripts/board/handoff.ts` checks a line carrying `file` against the schema's `journalLine` and skips one that fails | validated | yes: `tree`, `commit`, `brief.sha256`, `report.sha256`, `file.sha256` |
| 17 | scan → findings | scan agent → window (including the blind Design check after a Ghost) | the agent's final message | `.claude/agents/scan.md` fixes the first line (`[scan:<task>]`) | prose | no |
| 18 | window → journal (path, merge, superseded) | window → `pnpm board` | `event:path`, `event:merge`, `event:superseded` lines in `ghosts.jsonl`; `event:merge` lines are written by `pnpm task:merged` and the shift runner, not by hand, the others by hand | `PathEvent`, `MergeEvent`, `SupersededEvent` in `scripts/board/handoff.ts`; `event:path` also in window.md § Choosing the contour and AGENTS.md § The path line and its verification word; verification words in `scripts/board/verification.ts` | unvalidated | revision only, when a path line carries `sha` |
| 19 | morse → prediction | `scripts/morse/cli.ts predict` → nothing in code | one JSON line appended to the journal named by `--journal` | `runPredict` in `scripts/morse/cli.ts` (`task`, `base`, `head`, `verdict`, `rule`, `why`); refuses a journal inside a repository (`scripts/morse/journal.ts`) | unvalidated | revision only (`base`, `head`) |
| 20 | mutation → judgement → review | `construct mutate apply` → `construct mutate judge` → review agent | `.construct/mutations/<id>.json` and `.orig`, then the `--json` output | `MutationRecord`, `BaselineRecord` in `src/commands/mutate/record.ts`; judge refuses a copy whose sha differs (`src/commands/mutate/judge.ts`, line 84); output keys pinned in `contract/surface.json` (`jsonKeys["mutate judge"]`) | validated | yes: `baselineSha`, `mutatedSha` |
| 21 | board → reader | `pnpm board` → window, owner | `--json` (`format: board/4`, `JSON_FORMAT` in `scripts/board/json.ts`) and `board.txt` in the handoff directory | `boardJson` in `scripts/board/json.ts`; `scripts/tests/board/board.test.ts` | unvalidated (versioned, not checked by its reader) | reads the first eight hex of `.approved-sha256` (`approvalOf`, `scripts/board/handoff.ts`, line 137) and shows it; no digest of its own inputs |

Counts: validated 7 (#2, #6, #8, #10, #11, #16, #20; #10 and #11 on one side only), unvalidated 9
(#3, #4, #9, #12, #13, #14, #18, #19, #21), prose 5 (#1, #5, #7, #15, #17).

## Records of a retelling that went wrong

Each is a hand-over where one party restated what another produced, instead of passing it on.

- **The agreed acceptance lost in the args.** *An acceptance line was agreed and then left out of the
  arguments the ladder received* ([observations.md](observations.md), 2026-09-24): the args were written
  by hand from the agreed line, and one item did not arrive. Contour #6 now has a parser.
- **The harness paraphrased the witness it ran.** *The witness procedure's first live run*
  (observations.md, 2026-09-28): eight of nine `command` fields were paraphrased although every
  sha256 matched, and the rung ended `acceptance not witnessed`, about 2.1M tokens by `construct
  cost`. Contour #8.
- **The ledger row is a retelling of the result, and half were never written.** *Half the ladder runs
  were never recorded* (observations.md, 2026-09-21): 29 entries against 65 runs; the step is L0 by
  [0003](decisions/0003-run-ledger-stops-at-l0.md). *The ladder reported done for a run that changed
  nothing* (2026-09-26): the row says `done` and has no field that can say the status was later found
  false. Contour #10.
- **The prompt is not only the brief.** *The runtime relays the triggering message to a ladder's
  agents, above their brief* (2026-09-27). Contour #7.
- **The journal drifts from the shape its reader declares.** Read with `grep` over `ghosts.jsonl` in
  the handoff directory on 2026-09-30 (149 lines): `merged` 6, `ready` 1 and `note` 2 lines carry event
  names outside the union `readJournal` declares; one `event:task` line says in its own `note` that it
  "restates the … hand-ladder line in the journal shape … so the board reads it"; one `event:path`
  line records that the args (~96 KB) travel inline because the Workflow takes args inline only.
  Contours #12, #16, #18.

## Gaps

- **The verdict stands on a prose report.** #15 → #16: since `ghosts:verdict`, the journal line names
  the digest of the report, the tree it reviewed and the brief it reviewed against, but the review
  report itself still has no shape past its first line. The same holds for scan findings (#17).
- **The hash chain reaches the journal, through a row written by hand.** #1 → #6 → #10 → #12: the
  args file names the approved hash it was built from, the ledger row copies the args hash and the
  approved hash from the build's handle, and the launcher writes `argsSha256` on `event:task` only when
  the file, the approved hash and the row agree ([0044](decisions/0044-the-hash-chain-reaches-the-ledger-row-and-the-journal.md)).
  The link through the row is L0: step 4 of the skill is prose, and a row with no hashes leaves the
  line at `null`, which names a broken link, not a run that did not happen. #9 still carries the
  hashes on `done` and `degraded` only.
- **The ledger row is written by hand from the result, and three readers read it three ways.** #9 →
  #10: the result has no schema, the row's shape is prose in the skill, one reader validates it and two
  cast it, and it is declared outside the public contract.
- **One journal file, several writers, no schema.** #12, #16, #18: code writes `event:task`, the window
  writes the rest by hand, and the board reads every line with a cast; event names outside its union
  are already in the file.
- **The matrix row has two definitions.** #3: `Row` in the shredder and `MatrixRow` in the launcher,
  with the contour typed `unknown` on the reading side and no format field.
- **Markdown tables as carriers.** #4, #13: `status.md` and `owner-merges.md` are parsed by cell
  position in three places.
- **A producer with no consumer.** #19: the Morse prediction line is written and nothing in the
  repository reads it.

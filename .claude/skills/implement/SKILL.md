---
name: implement
description: Implement a task through the reasoning-budget ladder — classify effort, run a low-effort implementer under constraints, verify with the harness, escalate only on repeated failure or ambiguity.
user-invocable: true
disable-model-invocation: true
argument-hint: <task with an acceptance criterion>
---

Run the reasoning-budget ladder for the task in `$ARGUMENTS`. The rules are in the Reasoning budget
section of `architecture/principles.md`; repo specifics (harness command, high-effort areas) are in the
repository's CLAUDE.md and `construct.json`, and in an attached repository in `.construct/attach.json`
and `.construct/high-effort-areas.md`.

0. Before the first token is spent on classification and before any agent, print the entry card. Place
   the agreed text: when `.construct/implement-agreed.txt`
   already exists, the Ghost launcher wrote it from the approved brief before this session: use it as
   it is and never rewrite it, not even from `$ARGUMENTS`. Otherwise write `$ARGUMENTS` verbatim there
   (create the directory if needed). Then run
   `node scripts/construct/check-acceptance.mjs card --brief .construct/implement-agreed.txt` and print
   its stdout unchanged, never retyped: four rows, `CONTRACT`, `EXPECT`, `ACTION` and `RESULT`, whose
   `RESULT` is `accepted · not started`. A value the brief does not hold is written
   `<what> not recorded in the brief`, never estimated. On a non-zero exit relay its stderr verbatim and
   stop.
1. Classify the effort class and tell the user the class and the one-line reason before anything
   else. Read the repository's CLAUDE.md for its harness command and its high-effort areas; in a
   repository with no `construct.json` and a `.construct/attach.json` (an attached one) the areas are
   the lines of `.construct/high-effort-areas.md`, which discovery writes, and when that file is
   absent the one-line reason says `high-effort areas not recorded` and the class comes from the task
   alone. A task
   that names or must touch a high-effort area, the API contract, a composition model, the
   dependency policy or the security invariants is `high`. A new endpoint, a new integration or a
   change across several modules is `medium`. Everything with an existing pattern to copy and a
   contract already defined is `low`. What a `high` task requires, because of what it touches, is a
   design before any implementation; once that design is settled, the task is carried out as `medium`
   implementation tasks, each with the design attached as its `Design:`. A brief that is one of those
   tasks is `medium`, and the one-line reason says whose design it carries.
2. Write the acceptance criteria in two to four verifiable lines. If the task has no statable
   criterion, say so and stop; the ladder is not for one-line edits or open-ended exploration.
   The args come from one deterministic parser, never from you. The agreed file is the one step 0
   placed; run
   `node scripts/construct/check-acceptance.mjs build --brief .construct/implement-agreed.txt --out .construct/implement-args.json`.
   The build writes the whole args object to that file as one line of JSON: `task` (the brief's first
   line, without a leading `/implement `), `effort` (the first word after `Effort:`), `agreedSha256`
   (the sha256 of the whole agreed `/implement` text, the `Sketch:` line included; on a Ghost the
   approved hash is the same text without that line, so the two differ whenever the brief carries one),
   `acceptance`, `witnesses`, `witnessDigests`, `invariants`, `immutable`,
   `harness` and, when the brief carries a `Design:` section, `design` (its body, verbatim). On stdout
   it prints the handle, one line of JSON: `argsPath`, `argsSha256` (the sha256 of the bytes it
   wrote), every field of the file except `witnesses` and `design`, and `hasDesign`. The handle is
   what the Workflow receives; the file is what the agents read, pinned by its hash. A label counts at the start of a line or right after the
   end of a sentence; the same word elsewhere in prose, or inside backticks, is text. The brief splits
   what it asks for in two. **Acceptance** is red before the change and green after it, and it is the
   gate: each item ends with its witness, `— witness: \`<command>\``, a command that exits non-zero on
   the base and zero after the change. The witness is fixed in the brief before the run (0027); the
   build carries it into the file's `witnesses` as `{ "criterion": ..., "command": ... }` verbatim
   (double spaces, tabs and newlines inside the backticks survive), refuses one `bash -n` rejects
   before calling any agent, and carries its sha256 into `witnessDigests` as `{ "criterion": ...,
   "sha256": ... }` of the raw command, never the normalised criterion. The implementer reads
   `witnesses` from the file, and the harness agent never sees a command: it extracts each one with
   `node scripts/construct/check-acceptance.mjs witness --args <argsPath> --sha256 <argsSha256> --witness-sha256 <sha256>`,
   which selects the witness by the sha256 of its command from `witnessDigests`, never by its position,
   and refuses a file whose sha256 differs or a witness sha256 the file does not hold, so it cannot run
   anything but what the brief fixed. **Invariants**
   are green before and after, such as "the harness is
   green"; the harness holds them and they reach `args.invariants` unwitnessed. An item the base
   already satisfies belongs in invariants, because it can never be witnessed red. **Immutable** names
   paths the change may not touch, each a file or, ending in `/`, a directory, and a rung whose changed
   files include one fails as `immutable changed`. `harness.command` comes from `construct.json`, or
   from `.construct/attach.json` when `construct.json` is absent (an attached repository);
   `harness.contractPaths` is `contracts.path` and `contracts.types` from `construct.json` when
   `contracts` is non-null, plus the comma-separated paths on a `Contract paths:` line in the
   repository's AGENTS.md. `harness.contractCheck` is the command on a `Contract check:` line there, or
   `''` when there is none. Both lines live in AGENTS.md after its `construct:end` line, where `sync`
   keeps them. CLAUDE.md is not a source: a `Contract paths:` or `Contract check:` line found only in
   CLAUDE.md makes the build refuse, naming the line and saying `moved to AGENTS.md`. The ladder
   derives the result's `contractChanged` from `harness.contractPaths`: true only when a path in the
   harness's `changedFiles` equals one of these exactly. When `harness.contractPaths` is non-empty and
   `harness.contractCheck` is a non-empty string, the check is declared: the harness agent runs it after the
   harness command passes, and a rung whose declared check is red, unreported or reported under another
   command is `contract check failed`, never `done`: the reported `command` must equal
   `harness.contractCheck` byte for byte, as a witness's `ranSha256` must equal its digest. A red check's
   reason names the command and its exit code, followed by its last lines when it reported any.
3. The build is the only check that the brief reached the args. On a non-zero exit it has refused the
   brief — no `Acceptance:` section, an acceptance item with no witness (`no witness`), a witness
   holding a backtick (`backtick`), no harness command, a `Contract paths:` or `Contract check:` line
   found only in CLAUDE.md (`moved to AGENTS.md`), or an unreadable file — and printed nothing on
   stdout: stop, do not call Workflow, relay its stderr verbatim, and write no line to
   `.construct/runs.jsonl`, because there is no Workflow run identifier and step 4 forbids inventing
   one. On exit `0`, call the Workflow tool with `scriptPath` set to
   `scripts/construct/implement.workflow` (the ladder script lives with the project's scripts, not
   under `.claude/`) and `args` set to the handle the build printed on stdout, unchanged, never the
   file's content: never add, rewrite, merge or drop an item. The one field you may add is `retryLimit`. It is optional
   and defaults to `0`: a rejected response is not re-asked, and the run stops with the validator's
   error so a person reads it. Each retry is a whole new agent call that repeats the agent's
   exploration from scratch — measured at roughly three million billable tokens for an architect —
   and it cannot fix a contradiction in the task, because the agent may not change the task. Raise it
   only when a rejected response is expected to be a transient shape error rather than a bad brief.
   The user's `/implement` invocation is the opt-in the tool requires.
   Precondition: start the ladder only from a session whose working directory is the task's own worktree, and never after switching into a worktree with `EnterWorktree`: that mode refuses git outside the worktree, so the witnesses and the base worktree cannot run and the run ends `base unverified`. Before the run, a `harness` agent can check in seconds that `git -C "$(mktemp -d)" init -q` and `git worktree add --detach <tmp> <base sha>` work from where the run starts.
   Precondition: start the ladder only from a turn whose only user message is the /implement invocation. The Workflow runtime relays the triggering user message into the implementer's input as a request that outranks the computed brief (observed in wf_c3fc5325-1c7). If a user message arrives in the turn you meant to start from, answer it first and start the ladder in a later turn.
   The ladder cannot check this precondition — the script sees no transcript, and an agent call
   returns only the object its schema allows — so it holds by discipline alone. After the run, the
   implementer's transcript in the session's `subagents/workflows/<run>/` shows whether it received
   anything besides the computed prompt. Note the run identifier the
   Workflow tool reports when it launches the run and again when it completes; step 4 records it.
   The harness agent reports, on every call, the sha256 that `shasum -a 256 <argsPath>` prints as
   `argsSha256`, and the ladder compares it with the handle's before it reads anything else of the
   verdict.
   The design step runs inside the ladder, not before it, and its outcome is one of the `attempts`
   like any other. The statuses a run can return are:
   - `done` — a rung changed files, passed the harness, had every acceptance item's witness from the
     brief run verbatim (its `ranSha256` matching `args.witnessDigests`' sha256) and fail on the base
     (run in a worktree of its own at the base sha) and pass on the working tree, and every design step
     the run took completed. An
     implementer that reports done with no changed file, or a green tree with nothing changed, is a
     `no change` attempt and never `done`. A rung whose harness ran a witness the sha256 does not match
     — a substituted, edited or unrun script — is a `witness not run verbatim` attempt, checked after
     an immutable path and before an unwitnessed acceptance, and never `done`. A reported witness is
     matched to the brief's by its criterion and its `ranSha256`, and the harness is not asked to report
     the witness's command. A rung whose changed
     files include a source file (a path
     with a `src/` segment ending in `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` or `.cjs`,
     not `.d.ts`) and no test file (a path with a `tests/` segment named `*.test.` with one of those
     extensions) is an `untested change` attempt, never `done`, and its reason names the source files.
   - `degraded` — a rung passed the harness and the witness, but a design step was rejected by the schema and the
     run continued without it. The result's `effort` is the class that actually executed.
   - `design incomplete` — a high-effort run whose architect was rejected by the schema. No
     implementer ran without a spec; the result carries the validator's text in `validationError` and
     the way out in `recovery`, which is a measured route rather than advice: re-running one class
     lower with the design written into the brief produced the design on three of the three occasions
     it has been tried on the construct's own repository.
   - `failed` — every rung ran and none passed: the harness stayed red, the rung changed nothing, or
     the acceptance was not witnessed; `lastFailure` carries the last reason.
   - `blocked` — the last rung stopped on a question, or the brief carried no acceptance or an
     acceptance item with no witness; `question` carries it verbatim.
   - `base red` — the harness was red on the base before any change, so no rung ran; `lastFailure`
     carries the excerpt. Make the base green, or name what is red on purpose, before running again.
   - `args unverified` — the harness reported an `argsSha256` other than the handle's: the file the
     agents read is not the file the build wrote. At preflight no rung ran, and the one attempt is a
     rung-0 `args mismatch`; at a verify the run stops at that rung with an `args mismatch` attempt,
     with no higher rung and no design step. `validationError` names the file and both hashes. Build
     again and pass the handle it prints.
   - `base unverified` — the harness's verdict on the base was rejected by the schema, so no rung
     ran; `validationError` carries the validator's text. It is also the status of a rung whose
     witness is invalid (outcome `witness invalid`, checked after a witness not run verbatim and
     before an unwitnessed acceptance): after the change the witness exited 126 or 127, or exited 2
     with a shell syntax error, on any rung; or it failed with the same exit code and the same last
     lines as on the base, once every temporary path is replaced by `<tmp>`, on this rung and on the
     rung before it. One rung failing as on the base is an unwitnessed acceptance and the ladder goes
     on; a rung between that does not fail that way starts the count again. No implementation can turn
     such a witness green, so the run stops at that rung, with no higher rung and no design step, and
     the reason names the witness; `validationError` carries it.
   - `stopped` — the run was stopped from outside before it returned, so the runtime gave no result.
     It is the one status the script never returns; you write it.
4. Record the run: append one JSON line to `.construct/runs.jsonl` (create the directory if needed)
   with exactly these fields and no others:
   - `run` — the Workflow run identifier from step 3. It is the key `construct cost` joins the entry
     to the runtime's session data on. Never invent one: an entry without it is reported as
     unjoinable, which is the truth about it.
   - `at` — the ISO timestamp.
   - `task` — the task text, first 120 characters.
   - `effort` — the class the run performed: the result's `effort` when it carries one, and only
     then the class you chose in step 1. A run whose design step did not complete is never written
     down as `high`; the result has already degraded it.
   - `status` — the result's status verbatim, one of the nine in step 3.
   - `rung` — the effort of the rung that finished: `effort` from the result when it carries one,
     otherwise the `effort` of the last entry in `attempts`.
   - `attempts` — the result's `attempts` array verbatim; each entry carries its `rung`, `effort`,
     `outcome` and the `reason` that separates an invalid response shape from a red harness, from a
     rung that changed nothing (`no change`), from a rung that changed an immutable path
     (`immutable changed`), from a rung that changed source with no test (`untested change`), from a
     rung whose declared contract check was red, unreported or another command (`contract check failed`), from an
     invalid witness (`witness invalid`), from an args file whose hash differs (`args mismatch`), from an acceptance not witnessed, from a blocked report and from a design the schema rejected.
   - `cause` — required when `status` is `stopped` or `failed`, and absent otherwise. It says why
     the run ended without passing, from the causes that status allows:
     - `stopped` / `environment` — it was failing on something outside the task, such as the
       machine, a tool the harness spawns or a file another writer left in the tree, and further
       rungs would have spent money on it;
     - `stopped` / `human` — a person stopped it for any other reason;
     - `failed` / `environment` — every rung ran, and the harness stayed red on something outside the
       task;
     - `failed` / `task` — every rung ran, and the harness stayed red on the task itself.
     `construct cost` reads a cause another status owns, a cause on any other status, or a stopped
     entry with no cause as malformed. A failed entry with no cause reads as `not recorded`: entries
     written before the field existed are kept as they are, never repaired.
   - `tokensSource` — optional. Absent, `tokens` is the standard measure: the Workflow tool's own
     accounting as it reported the run to you. Present, it names where the figure came from instead:
     - `runtime` — the runtime's stored record of the run, read after the tool reported nothing, as
       for a stopped run.
   - `agents`, `tokens`, `toolUses`, `seconds` — the Workflow tool's own accounting for the run,
     exactly as it reported it. Write `"unknown"` for a token figure it did not report, never `0`.
   - `agreedSha256`, `argsSha256` — the two hashes in the handle the build printed in step 2,
     copied unchanged whatever the status, `stopped` included. Never take them from the result,
     which carries them only on `done` and `degraded`, and never compute them again: they name the
     agreed `/implement` text and the args file this run read.
   The ledger carries counts and reasons only — never a prompt, a response or any other message
   content. This log is what tunes the ladder later; workflow scripts have no filesystem access, so
   it is written here, not by the script. Nothing enforces this step: the ledger is L0, and
   `construct cost` reconciles it against the runtime instead of trusting it. `.construct/` is
   gitignored, or excluded through `.git/info/exclude` in an attached repository.
5. Relay the result. It opens with the exit card: run
   `node scripts/construct/check-acceptance.mjs card --brief .construct/implement-agreed.txt --action '<action>' --result '<status>'`
   and print its stdout unchanged. Its `CONTRACT` and `EXPECT` rows are the entry card's byte for byte,
   because the same command derives them from the same file; never copy, retype or reword them. The two
   flags carry values from their sources:
   - `<action>` — the Workflow run identifier from step 3, then each entry of the result's `attempts`
     in order, its `effort` and `outcome`, then the rung that passed by name: the `rung` and `effort`
     of the entry whose `outcome` is `passed`, or `passing rung not recorded in attempts` when no
     entry has that outcome.
   - `<status>` — the `status` step 4 wrote to `.construct/runs.jsonl`, verbatim.
   Never compose, estimate or round a value: a value its source does not hold is written
   `<what> not recorded <where>`, naming the place that holds no record, and no row is left empty.
   Below the card come the files changed and the harness tail. A `done` result carries
   `argsSha256` and `agreedSha256`; put `agreedSha256` next to the approved hash when there is one.
   Put the result's `acceptance` — the items the ladder received, echoed verbatim — next to the
   agreed line, and name any agreed item missing from it. When the status is `blocked`, put the
   architect's or implementer's question to the user verbatim. When `failed` or `base red`, give the
   last failure excerpt. When
   `design incomplete`, say that the design step did not complete, give `validationError` as the
   runtime reported it, and relay `recovery` verbatim — a dead end that names no way out is how the
   next person decides the ladder is broken rather than that this run needs re-running lower; when `degraded`, say which design step was rejected and that the reported
   class is the one that executed, not the one that was requested.
   Unless `construct.json` sets `report.usage` to `false`, end with one usage line for this run,
   from the Workflow tool's own accounting: agents, subagent tokens, tool uses, wall time — so the
   cost of the rung that succeeded is on record next to the result. When `construct` is on the PATH,
   add the per-agent split from `construct cost --last --json` (implementer, harness, architect);
   when it is not, the Workflow accounting alone is the line — never guess numbers.
   Every figure in that line names what measured it: figures from the Workflow tool's own accounting
   say so, and figures from `construct cost` carry the `version` that command reports, which is the
   version of the binary on the PATH and not necessarily the sources you are working in. A relayed
   number that does not say what measured it is not written down.
6. Never commit. The user reviews the working tree first. After `done` the tree is only read: a
   change made in it afterwards, a refactor included, is outside the evidence the ladder produced, so
   it goes into the brief's Design and through the ladder again.

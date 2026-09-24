---
name: implement
description: Implement a task through the reasoning-budget ladder — classify effort, run a low-effort implementer under constraints, verify with the harness, escalate only on repeated failure or ambiguity.
user-invocable: true
disable-model-invocation: true
argument-hint: <task with an acceptance criterion>
---

Run the reasoning-budget ladder for the task in `$ARGUMENTS`. The rules are in the Reasoning budget
section of `architecture/principles.md`; repo specifics (harness command, high-effort areas) are in the
repository's CLAUDE.md and `construct.json`.

1. Classify the effort class and tell the user the class and the one-line reason before anything
   else. Read the repository's CLAUDE.md for its harness command and its high-effort areas. A task
   that names or must touch a high-effort area, the API contract, a composition model, the
   dependency policy or the security invariants is `high`. A new endpoint, a new integration or a
   change across several modules is `medium`. Everything with an existing pattern to copy and a
   contract already defined is `low`.
2. Write the acceptance criteria in two to four verifiable lines. If the task has no statable
   criterion, say so and stop; the ladder is not for one-line edits or open-ended exploration.
3. Call the Workflow tool with `scriptPath` set to `scripts/construct/implement.workflow.mjs` (the ladder
   script lives with the project's scripts, not under `.claude/`) and `args` as
   a JSON object:
   `{ "task": ..., "acceptance": [...], "effort": "low|medium|high", "harness": { "command": ..., "extra": [...] } }`
   where `harness.command` comes from `construct.json`, or from `.construct/attach.json` when
   `construct.json` is absent (an attached repository), and `harness.extra` lists any area-specific
   commands CLAUDE.md names for the files the task touches (usually empty). `retryLimit` is optional
   and defaults to `0`: a rejected response is not re-asked, and the run stops with the validator's
   error so a person reads it. Each retry is a whole new agent call that repeats the agent's
   exploration from scratch — measured at roughly three million billable tokens for an architect —
   and it cannot fix a contradiction in the task, because the agent may not change the task. Raise it
   only when a rejected response is expected to be a transient shape error rather than a bad brief.
   The user's `/implement` invocation is the opt-in the tool requires. Note the run identifier the
   Workflow tool reports when it launches the run and again when it completes; step 4 records it.
   The design step runs inside the ladder, not before it, and its outcome is one of the `attempts`
   like any other. The statuses a run can return are:
   - `done` — a rung passed the harness and every design step the run took completed.
   - `degraded` — a rung passed the harness, but a design step was rejected by the schema and the
     run continued without it. The result's `effort` is the class that actually executed.
   - `design incomplete` — a high-effort run whose architect was rejected by the schema. No
     implementer ran without a spec; the result carries the validator's text in `validationError` and
     the way out in `recovery`, which is a measured route rather than advice: re-running one class
     lower with the design written into the brief produced the design on three of the three occasions
     it has been tried on the construct's own repository.
   - `failed` — every rung ran and the harness stayed red; `lastFailure` carries the excerpt.
   - `blocked` — the last rung stopped on a question; `question` carries it verbatim.
   - `base red` — the harness was red on the base before any change, so no rung ran; `lastFailure`
     carries the excerpt. Make the base green, or name what is red on purpose, before running again.
   - `base unverified` — the harness's verdict on the base was rejected by the schema, so no rung
     ran; `validationError` carries the validator's text.
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
   - `status` — the result's status verbatim, one of the seven in step 3.
   - `rung` — the effort of the rung that finished: `effort` from the result when it carries one,
     otherwise the `effort` of the last entry in `attempts`.
   - `attempts` — the result's `attempts` array verbatim; each entry carries its `rung`, `effort`,
     `outcome` and the `reason` that separates an invalid response shape from a red harness, from a
     blocked report and from a design the schema rejected.
   - `agents`, `tokens`, `toolUses`, `seconds` — the Workflow tool's own accounting for the run,
     exactly as it reported it. Write `"unknown"` for a token figure it did not report, never `0`.
   The ledger carries counts and reasons only — never a prompt, a response or any other message
   content. This log is what tunes the ladder later; workflow scripts have no filesystem access, so
   it is written here, not by the script. Nothing enforces this step: the ledger is L0, and
   `construct cost` reconciles it against the runtime instead of trusting it. `.construct/` is
   gitignored, or excluded through `.git/info/exclude` in an attached repository.
5. Relay the result: status, the effort rung that succeeded and how many attempts it took, the
   files changed, and the harness tail. When the status is `blocked`, put the architect's or
   implementer's question to the user verbatim. When `failed` or `base red`, give the last failure excerpt. When
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
6. Never commit. The user reviews the working tree first.

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
   `{ "task": ..., "acceptance": [...], "effort": "low|medium|high", "harness": { "command": ..., "extra": [...] }, "retryLimit": 1 }`
   where `harness.command` comes from `construct.json` and `harness.extra` lists any area-specific
   commands CLAUDE.md names for the files the task touches (usually empty). `retryLimit` is optional
   and caps how often an agent whose response the schema rejects is asked again; leave it out for the
   default of one retry, set it to `0` to spend nothing on a rejected response.
   The user's `/implement` invocation is the opt-in the tool requires.
4. Record the run: append one JSON line to `.construct/runs.jsonl` (create the directory if needed)
   with `at` (ISO time), `task` (first 120 characters), `effort` (the class you chose), `status`,
   the rung that finished (`effort` from the result), `attempts` from the result, and the Workflow
   tool's own accounting for the run — `agents`, `tokens`, `toolUses`, `seconds` — exactly as it
   reported them. This log is what tunes the ladder later; workflow scripts have no filesystem
   access, so it is written here, not by the script. `.construct/` is gitignored.
5. Relay the result: status, the effort rung that succeeded and how many attempts it took, the
   files changed, and the harness tail. When the status is `blocked`, put the architect's or
   implementer's question to the user verbatim. When `failed`, give the last failure excerpt.
   Unless `construct.json` sets `report.usage` to `false`, end with one usage line for this run,
   from the Workflow tool's own accounting: agents, subagent tokens, tool uses, wall time — so the
   cost of the rung that succeeded is on record next to the result. When `construct` is on the PATH,
   add the per-agent split from `construct cost --last --json` (implementer, harness, architect);
   when it is not, the Workflow accounting alone is the line — never guess numbers.
6. Never commit. The user reviews the working tree first.

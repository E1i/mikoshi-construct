---
name: probe
description: Run a probe — read a repository or a tool someone else owns, answer the owner's question with evidence-classed findings, a coverage list and a verdict, and close the task by its report.
user-invocable: true
disable-model-invocation: true
argument-hint: <task card> <target and the question the owner asks>
---

Run the probe in `$ARGUMENTS`. A probe is the `probe` kind of the card in
[architecture/window.md § Choosing the contour](../../../architecture/window.md#choosing-the-contour-cheap-path-or-ladder-path):
it produces knowledge, not a change, so it ends in a report and never in a pull request.

## Boundaries

1. The target is read only. Clone it into a scratch directory outside this repository (`~/.construct/<id>-<name>/`)
   and pin the commit; every path you cite is `path:line@<sha>`. Write nothing into the target and nothing into
   this repository's tree.
2. Foreign tests and code run only in that scratch clone. No network action on the owner's behalf: no push, issue,
   comment, pull request, login, publish or account sign-up. Installing anything outside the clone waits for the
   owner's yes, as in window-core.
3. The scoring key stays with the owner. You get the assignment only; do not look for the key, an earlier probe's
   answer to the same question, or the owner's expected outcome.

## Output

Write into the scratch directory, beside the clone:

- `findings.jsonl`, one row per finding:
  `{"id":"F01","observed_fact":"…","class":"DOC|IMPL|EXEC|INTEG|INFER","evidence":["path:line@<sha>","cmd: … → exit 0"],"supports":["F03"],"open_question":"…|null"}`.
  The brief may add fields (area, negative direction, boundary, enforcement); keep them. No confidence scores:
  missing evidence goes into `open_question`.
- `coverage.md`: what was checked and how, what was not checked and why, every command run, every test that could
  not be run and why. Prose lives only here, and only where it points to rows.

Each finding carries exactly one primary class:

- **DOC** — a documented claim: the quote and its `file:line`.
- **IMPL** — observed implementation: the `file:line` of the code that does it.
- **EXEC** — a test or executable you ran or located: its name and `file:line`, the command and exit code if run,
  and which property it actually asserts. Located but not run is not witnessed.
- **INTEG** — evidence that one component is wired to another: a call site, build or feature wiring, a CI step, an
  installer that writes configuration.
- **INFER** — a relationship you inferred; `supports` names the IMPL, EXEC or INTEG rows it rests on.

Every DOC claim you checked links through `supports` to the rows that confirm or contradict it.

## "Searched, not found" is a claim

An absence needs proof like any finding. The search reaches the path on which the value decides something — the
branch, the guard, the call that acts on it — not the loader or parser that reads it in. Put the search commands
and their output in `coverage.md`. A search that stopped at the loader is reported as not determined. OpenAPPA N6
failed this way on `[boundary]`.

## Verdict

One line with its reason: **Capability** (the construct can take this in now, and what it brings), **Observe**
(worth following, not yet proven; name what would settle it) or **Park** (not now; name why). The verdict is an
opinion over the findings, not a witness: never cite it as a red→green proof for any task.

## Report and close

The report is written at every outcome, including a stop on budget or by Eddies: what was done, where it stopped,
what remains. It lives outside the repository, in the scratch directory or the shift directory.

- Line 1: the card. Then one line each, in this order: `contract: …` (the question and the target pinned at its sha),
  `expect: …` (the forecast, or `expect not recorded in <where>`), `action: …` (what was read and run), `result: …`.
  Then the verdict line, the paths of `findings.jsonl` and `coverage.md`,
  counts by class, the tests run, and what waits for the owner.
- Close with `pnpm task:close <id> --report <path> --verification <word>`, the word from
  [AGENTS.md § The path line and its verification word](../../../AGENTS.md#the-path-line-and-its-verification-word),
  and the reason for that word in the report. No pull request is expected.

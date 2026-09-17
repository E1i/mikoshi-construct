# 0011 — Design is part of the run, and a run reports the class it performed

Status: accepted · 2026-09-17

## Context

The ladder's design phase sat outside the rung loop: an `if (args.effort === 'high')` block that asked
the architect once and then fell through into the loop whatever came back.

On one high-effort run the architect failed structured-output validation and returned nothing.
`retryLimit` is `0`, so no second call was bought — [0008](0008-a-retry-buys-a-new-exploration.md) — and
that was the right outcome: it saved a second full agent entry of roughly 2.6M billable tokens. But
nothing described what happens when there is no second call. The spec stayed `null`, the implementer
ran with no design, the harness passed, and the run reported `effort: high, status: done` with a single
passing attempt. The architect's 2,648,458 billable tokens and its failure appeared nowhere. A human
reviewer then found by hand that the delivered work left a prohibition in the prose of a decision record
instead of in the code — the class of defect the design step exists to catch.

Three claims were false at once, all from the same placement: the run claimed an effort class whose
defining step had not executed, the attempts list claimed to record every failed attempt and did not,
and the status claimed success for a run that had silently degraded.

## Decision

The design step runs inside the loop and is recorded like any other attempt: `outcome:
'design schema invalid'` with the validator's text as its `reason`, distinct from `harness failed`,
from `blocked` and from an implementer's `schema invalid`.

On a task classified `high`, a rejected architect ends the run with status `design incomplete`,
carrying `validationError` the way a blocked run carries its question. No implementer runs without a
spec. This is not a principle about design in general but about what `high` means: `high` is chosen
where a contract, a composition model or a boundary changes, which is exactly where a green harness
proves the least.

On `low` or `medium`, where the architect is called only after an attempt has already failed or been
blocked, a rejected architect does not kill the run — the ladder may still try the next rung — but the
failure is in `attempts` and the run ends as `degraded` rather than `done`.

The effort a run reports describes what executed. A rung at `high` or `xhigh` whose design did not
complete reports `medium`, in the result and in the line the skill writes to `.construct/runs.jsonl`.

A retry limit of zero was and remains the right default. What was missing was never the retry; it was a
described path for the case the default creates. An unspecified fallback is how a correct decision
produces an incorrect run: the decision stayed cheap and true, and the silence around it turned a
stopped design into a successful-looking delivery.

## Consequences

`status` gains two values, `design incomplete` and `degraded`. The ledger reader in
`src/commands/cost/ledger.ts` takes `status` as free text, so existing lines stay readable and the new
ones join the same way; `summarizeLedger` counts both as not-done, which is what they are.

A high-effort run can now end with no work at all, on a validator error. That is the intended trade:
the cost of reading an error is a fraction of the cost of reviewing work that was never designed.

`degraded` is deliberately not `failed`. The work exists and the harness is green; what is missing is
the design step, and the status says which of the two it is.

## Enforced by

`tests/ladder-run.test.ts` (L3) executes the ladder against stubbed agents and pins the recorded
outcome, the blocking status on `high`, the continuation on `medium`, and the reported class of a run
whose design was skipped. `tests/agent-output-contract.test.ts` (L3) keeps both copies of the script
byte-identical; `tests/cost.test.ts` (L3) pins that a `design incomplete` line is readable next to a
`done` one. That both copies of the `/implement` skill document every status is L1 review. One residual gap is
named rather than hidden: the ladder test evaluates the script's own source outside the runtime that
normally drives it, so it proves the decision logic and not that the runtime calls it the same way.
The positive half of that closes cheaply — the first `high` run after this change writes a ledger
line whose attempts must carry the design step with its outcome — while the negative half, a real
architect failing against the real runtime, is observed when it happens and is not manufactured.
The list of globals the test injects — `args`, `agent`, `log`, `phase` — is itself an unverified
claim about how the runtime calls the script, and nothing checks it. While the runtime does not
change this costs nothing; when it hands the script a new global the test will fail loudly, and the
repair is to extend that list deliberately, having read what the new global is, rather than
reflexively to make the suite green again.

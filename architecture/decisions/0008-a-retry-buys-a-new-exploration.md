# 0008 — A retry buys a new exploration, not a new attempt

Status: accepted · 2026-09-17

## Context

The ladder calls an agent with a schema. Validation happens inside that call: the runtime re-asks the
model up to five times before giving up, and that cap is the runtime's, not ours. On top of it the
ladder has its own `retryLimit`, which counts whole additional agent calls.

The two layers look alike and are priced nothing alike. Measured on one pair of runs of the same task:
an architect that failed validation five times and returned nothing cost 3,658,281 billable tokens; the
architect that produced a valid spec on its first attempt cost 3,118,576. Subtracting two different
runs is an estimate of order rather than a measurement, but the shape is not in doubt — four extra
validation attempts were worth roughly 135k, while the call itself was worth three million.

Almost the whole price of an agent call is its fixed exploration of the repository, paid once before it
produces anything. Everything after that is a rounding error beside it.

## Decision

`retryLimit` defaults to `0`. A response the schema rejects stops the run with the validator's error
where a person can read it, rather than buying another attempt.

The general form, which outlives this default: an escalation that **continues** an agent that has
already paid for its exploration is cheap, and an escalation that **starts an agent again** pays the
entry price in full. A repeat call is always an expensive decision in this ladder, even when it
presents itself as one more go — about twenty times the price of the retries the runtime is already
performing inside the call being made.

This holds even if the runtime later exposes a knob for its own cap. The two layers are priced
differently and only the outer one buys a new exploration, so a knob on the inner one would not be a
reason to raise the outer default.

A second full call also cannot repair a contradictory brief, because the agent is not permitted to
change the brief. That was the case that produced these figures: the implementer stopped and named a
contradiction in the task, and the architect it escalated to spent a full exploration and returned
nothing.

## Consequences

A schema rejection now ends the run quickly and cheaply, and the person who wrote the task reads the
validator's complaint. When the cause is a bad brief — the expected case — that is the shortest path to
a fix, and the run that follows starts from a corrected task rather than repeating a misunderstanding.

The cost is that a genuinely transient shape error is no longer absorbed silently; it surfaces as a
stopped run. `retryLimit` remains a parameter for callers who expect that case and accept its price.

## Amendment · 2026-09-20 — the figures were counted wrong, the decision was not

Every number in the Context above came from `construct cost`, which summed the `usage` of every
assistant line in an agent's journal. The journal writes one line per content block of a response and
repeats that response's `usage` on each of them, so each multi-block response was counted two or three
times. The command now deduplicates by request identifier, and `tests/cost.test.ts` fails if it stops.

Restated with the corrected count: the architect that failed validation five times and returned
nothing cost **1,528,014** tokens, not 3,658,281. The subtraction of two different runs that produced
the 135k estimate is superseded below and should not be quoted again.

**The split, measured directly.** Dividing five architect entries at the point of their first
`StructuredOutput` call separates the exploration from the answering:

| entry | attempts | exploration | answering | per attempt |
|-------|---------:|------------:|----------:|------------:|
| `wf_6592af6d-376` | 4 | 1,481,496 | 398,506 | 99,626 |
| `wf_f1d74f7a-3cd` | 3 | 557,751 | 222,756 | 74,252 |
| `wf_3ef46fa8-e99` (a) | 5 | 727,969 | 297,728 | 59,545 |
| `wf_3ef46fa8-e99` (b) | 5 | 385,309 | 283,687 | 56,737 |
| `wf_f910421e-fe0` | 1 | 1,185,408 | 118,455 | 118,455 |

An internal attempt costs 57k to 100k; the exploration a new entry pays before it answers anything
costs 385k to 1.48M. The ratio is between five and twenty to one, not the thousand to one that the
0.3.0 release note claimed. **The decision stands: `retryLimit` defaults to `0`.** What changes is that
the margin is narrower than the Context implied, so the reasoning is worth re-reading rather than
cited as settled.

**An argument the other way, which does not win today.** The record now shows that a refused answer
recovers. Two stand runs against this repository were refused twice and three times and then returned
a usable design on the attempt after; in the run that produced these figures both architects exhausted
all five of the runtime's internal attempts and stopped at the edge, where one further entry would
have bought five more attempts. That is a real argument for a non-zero `retryLimit` — not a
possibility considered and dismissed, but a live counter-argument with a price on it: 385k to 1.48M
for the entry, against a chance of recovery this record does not yet quantify. It loses today because
the price is paid every time and the recovery is not guaranteed. **It must be weighed again at the
next measurement, and a measurement that establishes how often an entry recovers would decide it.**

## Enforced by

`tests/agent-output-contract.test.ts` (L3) pins the default and that both copies of the ladder script
carry it; both copies of the `/implement` skill document what a retry actually costs.
`tests/cost.test.ts` (L3) pins that one response is counted once however many journal lines carry it,
which is the defect that produced the figures this record was first written with. The wider rule is
L1 review: nothing mechanical stops a future escalation from restarting an agent where it could have
continued one.

## Observation · 2026-09-21

Task 3 of the doctor-projection plan was run at `xhigh`. The architect failed structured-output
validation five consecutive times and returned nothing — another occurrence of the failure mode this
record already describes. It is recorded as an occurrence only: the population is too small to carry
a frequency, and nothing causal is claimed from it.

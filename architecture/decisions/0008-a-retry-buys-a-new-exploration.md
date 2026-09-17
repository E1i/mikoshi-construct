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

## Enforced by

`tests/agent-output-contract.test.ts` (L3) pins the default and that both copies of the ladder script
carry it; both copies of the `/implement` skill document what a retry actually costs. The wider rule is
L1 review: nothing mechanical stops a future escalation from restarting an agent where it could have
continued one.

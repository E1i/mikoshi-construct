# 0015 — Interpretation stays with the agent; the CLI records facts and checks them

Status: proposed · 2026-09-20

## Context

v5 asks the tool to recognise what a repository is — a monorepo, a single service, a library. The
temptation is to put that recognition in `detect`, where the signals already are: a workspace file,
an `apps/` directory, two deployables, a `Cargo.toml`. That would move judgement out of the agent
and into deterministic code, reversing the principle this tool is built on: the CLI detects facts,
the agent interprets the system.

## Decision

`detect` continues to report only what it can point at. It never names an architecture.

Discovery, which is the agent, writes the interpretation into the model as a hypothesis together
with the facts that support it. Those facts are not historical justification for a conclusion
already reached — they are the current evidence the hypothesis stands on. The CLI then does what
deterministic code is good at: check that those facts still hold, and report the hypothesis as
unsupported when they do not.

A hypothesis therefore has no independent truth state. Its state is derived on every read, never
stored, and has three values, which rule 2 keeps apart:

- `held` — facts are named under it and every one of them was evaluated and holds.
- `unsupported` — facts are named under it and at least one was evaluated and does not hold.
- `unknown` — no facts are named under it, or a named fact could not be evaluated.

`unsupported` asserts a negative and is therefore only honest when every named fact was actually
looked at. A fact that could not be read is not evidence of absence; it yields `unknown`.

No `confidence` number is recorded, under any name. [Rule 7](../epistemic-rules.md) says confidence
does not replace an evidence state, and a number beside a hypothesis invites exactly that
substitution.

## Consequences

Recognition of an unfamiliar stack improves by improving the discovery protocol, not by adding
detectors — the cheaper of the two, and the one that does not grow a matrix of frameworks.

A hypothesis can rot: the facts under it may be deleted or moved. Because the state is derived
rather than stored, nothing has to notice the deletion for the state to fall to `unsupported`.
This is the model's own enforcement, and the reason the facts are recorded beside the claim rather
than summarised into it.

## Enforced by

A test over a fixture whose supporting fact is removed: the hypothesis must report `unsupported`,
and the run must not restate it. A hypothesis with no facts named reports `unknown`, never
`unsupported`. A schema that rejects any additional property on a hypothesis, so a
confidence field cannot be added without changing the schema. L3.

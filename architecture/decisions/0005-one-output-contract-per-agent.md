# 0005 — One output contract per agent, declared by the schema

Status: accepted · 2026-09-17

## Context

In a field run the architect returned invalid JSON five times in a row — roughly 7% of the run's
tokens — on unicode dashes, emoji and nested backticks.

The contract is already declared to the runtime: `SPEC`, `REPORT` and `VERDICT` are passed as
schemas in `scripts/construct/implement.workflow.mjs`. The same contract is also written out in
prose, with a fenced JSON example, in `_claude/agents/*.md`. Two statements of one contract, and
the one in the agent file asks for a document formatted for a human.

## Decision

The schema is the only place the contract is stated. Agent files name the fields they must return
and say the runtime enforces the shape; they carry no fenced example to imitate.

Retries receive the validator's error text rather than a repeated instruction, the retry limit is
configurable, and every rejected output is recorded with its reason.

## Consequences

Agent files become less self-contained: read alone, an agent file no longer shows the exact output
shape. That is the cost of having one source of truth, and the schema is two files away.

A runtime without schema support gets a weaker contract. Accepted — that path is already reported
as unsupported rather than pretended to work.

Before treating this as closed, confirm from the run log whose retry loop burned the tokens. If the
runtime was already retrying, the fix is removing the duplicate and nothing else.

## Enforced by

Schema validation in the runtime (L4 on the workflow path), plus fixtures whose values contain
unicode dashes, emoji and nested backticks.

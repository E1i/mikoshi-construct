# 0003 — The run ledger stops at L0, and says so

Status: accepted · 2026-09-17

## Context

`.construct/runs.jsonl` is appended by step 4 of the `/implement` skill — an instruction in a
prompt. By this repository's own enforcement ladder that is L0: nothing makes the step happen, and
a run that skips it leaves no trace of having skipped it.

A runtime-independent ledger was proposed instead. It is not available: workflow scripts have no
filesystem access, and a runtime we do not control has no reason to write our journal. Claiming the
ledger is stronger than L0 would be the exact failure this tool exists to catch.

## Decision

The ledger stays where it is and is documented as L0, in the command's own documentation.

Instead of buying enforcement we cannot get, buy verifiability: `construct cost` reconciles ledger
entries against the runtime's session data wherever that data exists, and reports divergence in
both directions — a ledger entry with no session behind it, and a session with no ledger entry.

## Consequences

On Claude Code a skipped or invented entry is detectable. Elsewhere it is not, and the answer is
`unknown`, never `absent` — absence of a journal is not evidence that nothing ran.

Anyone reading the ladder's usage numbers gets them with their provenance attached, which is worth
more than a number that looks authoritative and was typed by a language model.

## Enforced by

Reconciliation in `construct cost` (L3 on Claude Code). Unknown on every other runtime, reported
as such.

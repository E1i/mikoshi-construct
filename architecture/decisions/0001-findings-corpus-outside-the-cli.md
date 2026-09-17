# 0001 — The findings corpus lives outside the CLI

Status: accepted · 2026-09-17

## Context

Three field runs produced enough material to propose a findings ledger: one record per candidate
finding, including the rejected ones, with claim origin, enforcement level bounds, evidence refs,
intent state and an annotator field. The purpose is a future filter for engineering systems that
contradict their own claims. The schema is sound and the runs justify it.

It was proposed to ship inside this package: `.construct/findings/<run-id>.jsonl`, a
`construct findings label` command, and a validator in `doctor`.

## Decision

The corpus does not ship here. It lives in a separate private repository.

This package emits exactly one thing the corpus can attach to: a stable task id printed by `/plan`,
so a corpus record can point at the task that closed a finding.

## Consequences

The CLI stays a bootstrapper. A twenty-field research schema, a labelling command and an
`annotator` field would raise the cost of adopting a tool that has no adopters yet, and would pull
details of other people's repositories into a public package by default.

The price is that corpus entries are transcribed by hand instead of collected automatically, and
the corpus grows slower. That is the right trade while the sample is three repositories: the schema
is still moving, and a schema that ships is a schema that cannot move.

Revisit when the corpus is large enough to say what the CLI must emit. Until then, anything beyond
the task id is out of scope here.

## Enforced by

Review (L1). Nothing mechanical prevents a findings schema from landing in this repository.

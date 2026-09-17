# 0002 — Discovery provenance is recorded in the manifest

Status: accepted · 2026-09-17

## Context

`/construct-discover` fills the markers in `AGENTS.md` and adds rows to
`architecture/security-invariants.md`. Those claims are then read — by a reviewer, by the next
agent, by `doctor` — as claims the repository makes. A claim written by this tool is not a claim
the repository made, and after one discovery run the two are indistinguishable.

The obvious fix is to tag each claim in place with `authored_by` and a sha. That puts machine
bookkeeping inside a document whose value is that people read it.

## Decision

Provenance lives in `construct.json`, never in the prose:

- `discovery.baseSha` and `discovery.filledAt`, recorded when discovery starts;
- per marker, `authoredBy` and the sha256 of the content discovery wrote.

When a marker's current content no longer matches that hash, it is owner-authored. The edit is the
evidence; there is no command to confirm ownership, because a command would be one more claim
nobody checks.

## Consequences

Markers stay readable. Provenance survives a rewrite of the prose, and `doctor` can report which
claims are still this tool talking to itself.

A marker rewritten by a different agent reads as owner-authored, since both are "no longer what
discovery wrote". That is an accepted limit: both mean the claim is no longer Mikoshi's, which is
the distinction this record exists to protect. Telling a human editor from another agent needs
evidence we do not have.

## Enforced by

`doctor` plus tests over a fixture repository (L3 once it runs in CI).

# 0044 — The hash chain reaches the ledger row and the journal

Status: proposed · 2026-10-01

## Context

The owner approves the sha256 of a brief's `/implement` text, and the launcher checks it before it starts a
session. Since [0041](0041-the-ladder-reads-the-args-by-path-and-hash.md) the args file the session builds
carries that hash as `agreedSha256`, and the build's handle names the file's own `argsSha256`. Nothing written
after the session carried either: the result names them on `done` and `degraded` only, the ledger row
([0003](0003-run-ledger-stops-at-l0.md), L0) named neither, and the journal's `event:task` line named neither
the brief nor the args a run read. A line in the journal could not be traced back to the text the owner
approved.

## Decision

1. **The ledger row may carry `agreedSha256` and `argsSha256`**, each 64 lowercase hex, copied from the
   build's handle whatever the status. The ledger-row contour becomes `1.1`
   ([0042](0042-a-contour-hand-over-is-a-file-with-a-recorded-schema.md)); both fields are optional, so rows
   written before it read as before, and `parseLedgerLine` refuses another form, naming the field.
2. **Every `event:task` line names `agreedSha256`**, the hash read from the brief's `.approved-sha256` and
   compared by `checkApproval`, including a line for a task that never reached a session.
3. **`argsSha256` on the line is the sha256 of the args file's bytes as read**, written only when the file
   parses as an object whose `agreedSha256` is the approved hash and the session's new ledger row names those
   same bytes; otherwise `null`. The launcher never builds the args itself, never re-serialises the file and
   never copies the row's hash without checking it.

## Consequences

- A tied line links the approved text, the args file and the ledger row; a `null` after a session says one
  link is broken or unrecorded, not which one.
- The link through the row is as strong as step 4 of the skill, which is prose: a session that skips the two
  fields leaves `argsSha256` at `null`.
- `contract:bump` reads any change of a contour's `$id` as breaking, so `1` → `1.1` is a minor release on
  0.x.

## Enforced by

- L3 tests: the ledger-row schema and `parseLedgerLine` on the same rows, `tiedArgsSha256` branch by branch,
  and the launcher end to end through the stub world (a tied session, an install that fails, args built from
  another text, args rewritten after the row, a row without the hashes).
- `contract:bump` on the contours section.
- L0 for step 4 of the implement skill.

## What would reverse it

An `event:task` line whose `argsSha256` is not `null` for a run whose args file was not built from the
approved text.

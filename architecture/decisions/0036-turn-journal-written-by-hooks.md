# 0036 — the turn journal is written by hooks

Status: proposed · 2026-09-30

## Context

[0003](0003-run-ledger-stops-at-l0.md) recorded that a runtime we do not control has no reason to write
our journal, so the run ledger is a step in a skill, L0, and `construct cost` reconciles it against the
session files. That covers what a ladder run decided. It says nothing about what an ordinary turn of a
session cost, ladder or not, and no session file is split by turn.

## Decision

1. **A hook this repository installs writes a second record, `.construct/turns.jsonl`.** The script is
   `.claude/hooks/turn-journal.mjs`, run by `.claude/settings.json` on `UserPromptSubmit`, `Stop`,
   `SubagentStop` and `SessionEnd`. A hook is a writer that does not depend on a skill step being
   followed.
2. **It does not change 0003 and does not replace the ledger.** The ledger stays L0 and records what
   the ladder decided; the journal records what each turn cost, measured from the transcript. `construct
   cost` reads each through its own reader and joins the journal to nothing: the ledger's key is a
   Workflow run id, the journal's are session and prompt ids. Its figures are never added to the runs'.
3. **It carries counts and names only.** Token counts, tool names, byte offsets, times and ids; never
   message content, at any moment of a turn.
4. **Ranges partition the transcript.** Offsets are line boundaries, and the ranges of a session follow
   each other, so a lost write shows as a gap, never as a smaller figure. A range that cannot be read
   against its cursor is `unknown`, never a number.
5. **An absent journal is `not recorded`,** never zero.

## Consequences

What the journal cannot see: sessions where the hooks did not run, a prompt that never reached
`UserPromptSubmit`, and a transcript format a later Claude Code version changed, which the reader
passes over line by line and counts as unreadable rather than refusing. Whether `SubagentStop` fires for
Workflow agents is not documented, so a turn's figure may or may not include a ladder run's agents.

The hook runs synchronously on four events with a five second timeout, always exits 0 and writes nothing
to stdout. Concurrent hooks queue on one lock directory; one that cannot take it in a second writes
nothing, and the range shows as a gap.

## Enforced by

L3 tests: `tests/turn-journal.test.ts` runs the hook as Claude Code does and `tests/cost-turns.test.ts`
pins the hook and `construct cost` to the same count on a recorded Claude Code sample. The `hook`
entries in `.claude/settings.json` are L0 configuration; nothing checks that a session honoured them.

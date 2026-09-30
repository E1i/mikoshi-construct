# 0038 — Risk is read from what the change does, the highest sign decides, and risk only raises a contour

Status: accepted · 2026-10-01

## Context

The contour step chose by the proof a task needs, not by what an error in it would cost. An
irreversible step could therefore take the cheap path, and a task could be over-rated from the words of
its ticket.

## Decision

1. **A Law.** The contour never falls below what an irreversible error demands. The highest sign decides,
   and the sign is read from what the change does, never from the words of the task. Risk only raises a
   contour. The table of signs lives in `/plan` and is data, revised as cases arrive.
2. **Three levels.** Critical asks for the ladder and a human, moderate for the contour the proof needs,
   low for nothing beyond the cheap path.
3. **Approving the brief is the stop.** The plan names the level and the sign that set it and asks
   nothing further. In a generated project the human is the person who approves the plan's brief and
   merges.
4. **The core here has three parts:** the mechanism of the ladder itself, a write into a repository
   someone else owns (including the content of every carrier that `init`, `attach`, `sync` or `detach`
   writes) and the security invariants. Every other change under `.claude/**` is owner-merged with no
   brief, unless it shows another critical sign.
5. **No risk field in the journal in v0.1.** It comes in v0.2, which ships the board reader first.

## Consequences

- An own-instructions change outside the core stays on the cheap path, merged by the owner.
- A permission granted through `.claude/settings.json` still reads critical.
- A change to a carrier's text reads critical.
- The worked examples live in AGENTS.md, not in this record.

## Enforced by

- L3 test: `tests/plan-risk-axis.test.ts` (the plan's words and table, both copies, the worked examples).
- L1 review, the weakest: whether an agent reads the work rather than the words, and the carve-out case
  by case.

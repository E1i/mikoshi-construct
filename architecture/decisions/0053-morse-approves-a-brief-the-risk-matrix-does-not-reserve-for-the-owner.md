# 0053 — MORSE approves a brief the risk matrix does not reserve for the owner

Status: accepted · 2026-10-06 · point 2 replaced by 0058

## Context

Every brief waited for the owner's approval of its hash. What the owner caught at that gate was mechanical: a base
that was already red (#582), an anchor against a file no task may change (#543), an unclassified path under
`scripts/ghosts/**` (#574), a witness that did not lint (#581). Since #570, `ghosts:hash` prints an approval line only
after a hard preflight that refuses each of those, so the gate cost the owner's time on briefs where nothing was left to
judge. The owner decided on 2026-10-05 that the hash stays and who approves changes.

## Decision

1. **The hash stays.** An approval still pins the exact `/implement` text, and the launcher still refuses a brief whose
   text drifted from it.
2. **R1 stays with the owner.** Replaced by [0058](0058-morse-approves-a-brief-of-every-risk.md). `pnpm ghosts:hash <brief> --by morse --card <N>` reads the card from the parking
   directory (`~/.construct/parking`, or `--parking <dir>`) and computes its risk from its `touches:` with
   `riskReading` (`src/card/risk.ts`, the matrix of #585), never from the card's stored `risk:` line. An R1 card —
   the ladder mechanism, the attach carriers, a security invariant — is refused with "waits for the owner".
3. **MORSE approves R2–R4 only when all of these hold**, checked before anything is built: the card has no `unclear:`
   field; the card has no `fall` in the journal ([window.md § Two falls cut the task](../window.md#two-falls-cut-the-task));
   the hash was never revoked; the brief's `expect:` line is a forecast with a p25–p75 band and its tokens are at or
   below p75. Then the build and the hard preflight run as for any approval.
4. **MORSE writes the journal first, then the approval file.** It appends `event:approval` (`by: morse`, `card`,
   `brief`, `sha256`, `sketch`, `risk`, `reason`, `forecast`, `ts`) to `ghosts.jsonl` and then writes
   `approved /implement text sha256: <h> sketch: <s> (<date>, morse)` to `.approved-sha256`. A journal it cannot
   write leaves no approval file. A file that already holds the same hash is left as it is, so an owner approval is
   never re-attributed.
5. **The launcher accepts a morse line only with its journal event.** A line whose approver is `morse` in any case
   launches only when the journal holds `event:approval` by morse for that hash and that card, and its `CONTRACT:` line
   says `by morse`. An owner line is read as before.
6. **The owner can revoke any approval.** `pnpm ghosts:launch --revoke <sha256> --card <N>` appends `event:revoke`;
   the launcher then refuses that hash on that card whoever approved it, and MORSE refuses to approve it again. A
   revocation is permanent for its hash: approving again takes a changed brief text.
7. A fall after a MORSE approval counts as any fall; two cut the task.

## Consequences

- The owner reads R1 briefs and the journal; R2–R4 briefs launch on MORSE's line without waiting.
- The forecast check compares the brief's own `expect:` line with its band and does not recompute it from the ledger.
  Since the forecast is a median, it catches `none`, a missing band and a hand-edited line, not an unusual task.
- The journal event is a tripwire, not a signature: whoever can write `ghosts.jsonl` can write a morse approval.
- A revocation acts at launch and in MORSE's gate only: `ghosts:verdict` and the merge do not read it, so a Ghost
  already launched on a hash revoked later still goes through review.
- Who merges does not change: [owner-merges.md](../owner-merges.md) still decides that.

## Enforced by

- L3 tests: `scripts/tests/ghosts/morse.test.ts` (the gate, the writes and their order) and
  `scripts/tests/ghosts/morse-launch.e2e.test.ts` (the launcher with morse lines and revocations).
- L1 review for what the risk matrix classes as R1.

## What would reverse it

A MORSE-approved brief whose run the owner would have refused at the hash, or a fall rate on MORSE-approved cards above
the rate on owner-approved ones.

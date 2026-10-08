# Evidence — #650 shard-delegates-owner-merge

Sketch: sketch/shard-delegates-owner-merge @ d366a1833adc85c545e9830df6c7c91c1fd9d444, cut from origin/main 1d7e2ba61a29b5638c08815514b62aec7373fb79 (rebased once when main moved from 1e15c1a).
Witnesses run as extracted from role/650/brief.md, in a worktree at the sketch reset --soft to origin/main ("after") and in a clean `git worktree add` of origin/main ("base").

## Base-red (origin/main 1d7e2ba)

A1 → 1 · A2 → 1 · A3 → 1 · A4 → 1 · A5 → 1 · A6 → 1 · A7 → 1 · A8 → 1 · A9 → 1 · A10 → 1 (vitest: no test file) · A11 → 1 (`undefined` ≠ script). 11 of 11 red.
Invariants on base: I1 `pnpm run quality` → 0 (3971 passed, 15 skipped; run as a non-root user, see note) · I2 → 0 · I3 → 0 · I4 `pnpm contract:bump` → 0.

## Sketch

A1–A11 → 0 each. I1 → 0 (307 files, 3981 passed, 15 skipped, non-root) · I2 → 0 · I3 → 0 · I4 → 0.
PR-equivalent: `scripts/release/version-pr-guard.ts` → 0; `pnpm contract:bump` → 0; `pnpm build && pnpm pack` → 0; gitleaks v8 detect over the history → 0 (no leaks; installed with go, docker had no daemon); acceptance matrix not run: scripts-only change, the fast path of ci.yml `changes`.

Note: this container runs as root; as root two cleanup.e2e tests (l2, s2: an unwritable ledger) fail identically on base and sketch because root ignores the file mode, so I1 was run as an unprivileged user on copies of both trees. The pnpm 12.4.2 tool's native binary was missing (Exec format error on nested `pnpm`); its install.js was run in the container.

## Mutations (construct mutate apply / judge, prediction written first; all four restored byte for byte)

- M1 scripts/shift/shift.ts `if (shard === undefined || lines.length === 0` → `if (true || lines.length === 0` → predicted red A2 'with a shard an owner PR is armed and journals the delegation' — named test turned red.
- M2 scripts/shift/shard.ts `if (VERSION_BRANCH.test(view.headRefName))` → `if (false)` → predicted red A6 'a version PR with a shard stays the owner' — red.
- M3 scripts/shift/shard.ts `line.event === SHARD_USED_EVENT && line.id === id` → `line.event === 'never' && …` → predicted red A4 'a used shard is refused' — red.
- M4 scripts/shift/shard.ts `if (readAttachRecord(root) !== null)` → `if (false)` → predicted red A5 'attach with a shard is refused' — red.

## Deviation from the prompt's witness form

The vitest witnesses count `✓ scripts/tests/shift/shard\.test\.ts > ` instead of bare `✓ `: pnpm 12 sometimes prints `✓ Lockfile passes supply-chain policies` before exec, which made the bare form count 2 on the sketch and 1 on base (A1 was green on base, red on the sketch, in one run).

## Open questions for the owner

1. An owner-merged *path* (e.g. `.claude/**`, `architecture/security-invariants.md`, `AGENTS.md`) with decision auto prints `merge is Eli's` like decision owner; the sketch delegates both. Should a shard arm only decision owner?
2. CI state `none` (no checks recorded yet) arms, read as not red and not unknown. Confirm, or treat it as unknown?
3. A question or guard refusal stops that card (one stop line) and the run goes on to the next card, as stops do today; the shard stays spent. Is "stops the run" meant to end the whole chain instead?

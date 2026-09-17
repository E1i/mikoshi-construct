# 0007 — Doctor executes nothing from the repository it audits, and therefore never claims L4

Status: accepted · 2026-09-17

## Context

`doctor` answers "is this construct still enforced". Answering it precisely invites execution:
resolve the target's `eslint.config.mjs` to see which policy a file actually gets, run the harness
command to see whether it is green, import the target's vitest config to read the include globs.

`doctor` is run through `npx` in a fresh clone, at exactly the moment a person has not yet decided
whether they trust that code. A flat ESLint config is a module, so "we only read the config" is not
a defence: resolving it runs the audited repository's own code on the instruction "check whether
this repository is honest". That is the difference between a linter and a supply-chain vector.

The same boundary decides what `doctor` may conclude. Branch protection and organisation rulesets
live in the GitHub API, not in the repository, so no file can show that a check blocks a merge.

## Decision

`doctor` executes nothing from the repository it inspects: no child process, no `import()` of a path
inside it, no `require` / `createRequire` / `node:module`, no call into the target's ESLint or
Vitest APIs. Every verdict is derived from reading file text, over a declared read set — the files
`construct.json` records plus a named allowlist — with no recursive walk.

Because of that boundary `doctor` never reports L4. The most a file can support is L3, CI that runs
the harness. Anything it cannot read literally is `unknown`, never `absent`: `red-gate` is always
`unknown` because proving a clean checkout is green means running it, `ci` is never `absent` because
doctor has no scope evidence by construction, and a non-literal include glob is `unknown`.

## Consequences

`doctor` is weaker than a runner that would execute the target, and says so in its evidence instead
of guessing. The precise question — which config a file resolves to — is answered by a policy test
inside the audited repository's own harness, where executing that repository is the point; `doctor`
only reports at what level that test is run.

Resolution accuracy cannot be added later without reopening this record: a "just read the config"
shortcut is the same vector under a different name.

## Enforced by

The `spawnPolicy` `no-restricted-syntax` block in `eslint.config.mjs` (L4 CI): `src/**` may not
import `node:child_process` or `node:module`, use `import()`, `require`, `require.resolve` or
`createRequire`. `tests/dependency-policy.test.ts` asserts one sample per form, and the doctor check
tests assert that no verdict is L4, that `ci` is never `absent` and that `red-gate` is always
`unknown`.

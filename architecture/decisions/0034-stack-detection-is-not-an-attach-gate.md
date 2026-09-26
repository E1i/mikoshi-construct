# 0034 — Stack detection is not an attach gate; what holds after attach is doctor's to say (0033)

Status: accepted · 2026-09-27

## Context

`attach` refused a repository whose detected layout was `empty` or `unknown`, under the reason
`unsupported-stack`. The layout detector reads directory names and manifests, not stacks: one
directory named `apps`, `packages`, `libs` or `services`, a `src/` or a `package.json` made a layout
`single` or `monorepo`. So a Go repository with a `services/` directory attached, and the same
repository without it was refused (#232). The refusal measured a directory name.

Nothing attach writes depends on the stack. Its carriers are the same in every repository, and the
one stack-specific input, the harness command, is named by the person attaching (`--harness`, required
with `--yes`). A stack check before attach therefore guards nothing attach relies on, and every way of
making it measure more — a Node manifest, a `src/` directory — reads names again.

## Decision

1. **attach does not read the stack.** It refuses a tree only when there is nothing to attach to: the
   directory holds `.git` and at most the files an empty directory may hold (`isEmptyDir`). The
   reason is `nothing-to-attach`; `unsupported-stack` is gone.
2. **Honesty after attach is 0033's.** Whether the named harness actually runs the repository's own
   verification surface is not decided at the door. `doctor` reports it afterwards as
   `harness.state`, which reads `checked` only on observed coverage of that surface.

## Consequences

- Repositories in any language attach, with or without a `services/` directory. The owner's
  observation of non-Node repositories after entry becomes the normal route rather than a loophole.
- An attached repository whose harness does not cover its code is not refused; it reads
  `does-not-cover` or `unknown` from `doctor`, which is where that fact is observable.
- `detect` stays a source of facts for `init`; attach imports from it only `isEmptyDir`.

## Enforced by

- L3 tests: a Go repository attaches and `detach` returns it to what it was; the same repository with
  and without `services/` gets the same decision; an empty directory and a README-only directory are
  refused as `nothing-to-attach` (`tests/attach.test.ts`).
- Lint: `src/commands/attach/**` may import nothing from `src/detect` but `isEmptyDir`
  (`eslint.config.mjs`).

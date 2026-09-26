# 0034 — Stack detection is not an attach gate

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
2. **What holds after attach is not decided at the door.** Whether the named harness runs the
   repository's own verification surface is 0033's question, and 0033 answers it only where `doctor`
   reads a `construct.json`. On an attached repository `doctor` reads `No construct.json here`
   (`state: no-manifest`) and reports no harness state at all, so today nothing evaluates the harness
   of an attached repository. This decision does not close that gap; #247 does.

## Consequences

- Repositories in any language attach, with or without a `services/` directory. The owner's
  observation of non-Node repositories after entry becomes the normal route rather than a loophole.
- An attached repository whose harness does not cover its code is not refused, and until #247 no
  command says so: `doctor` gives no report on it. What the decision guarantees today is only that
  nothing reads `checked` there, because nothing reads it at all.
- `detect` stays a source of facts for `init`; attach imports from it only `isEmptyDir`.

## Enforced by

- L3 tests: a Go repository attaches and `detach` returns it to what it was; the same repository with
  and without `services/` gets the same decision; an empty directory and a README-only directory are
  refused as `nothing-to-attach`; a Go repository with `--yes` and no `--harness` is refused as
  `no-harness`; and `doctor` gives no report on an attached Go repository, pinned so the test has to
  change when #247 lands (`tests/attach.test.ts`).
- Lint: `src/commands/attach/**` may import nothing from `src/detect` but `isEmptyDir`
  (`eslint.config.mjs`).

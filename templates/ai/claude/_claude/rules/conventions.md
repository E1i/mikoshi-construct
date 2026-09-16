# Code conventions

Repository-wide conventions for new code and the code you touch. Architecture, security and the reasoning
budget are in [architecture/principles.md](../../architecture/principles.md).

## Comments

- **Write no comments.** Not per-line, not "why" comments, not file-header blocks, not JSDoc/TSDoc
  prose — including on exported functions and on shared types other packages consume. The code is
  read directly; it should explain itself.
- A comment that feels necessary is a signal to make the code self-describing: extract a named
  function, introduce a named constant, rename a variable, or push the fact into a test name where
  it is executable. Move the knowledge into an identifier — don't delete it along with the comment.
- **Pragmas are not comments and are never stripped**: `eslint-disable*`, `@ts-expect-error`,
  `@ts-ignore`, `stylelint-disable*`, and triple-slash `/// <reference … />` directives, which are
  compiler input. Where a lint config sets `reportUnusedDisableDirectives`, a refactor that removes
  the need for a suppression must delete its directive in the same commit.

## Async

- Prefer `async`/`await` to `.then()` / `.catch()` / `.finally()` chains **where the enclosing
  context can be async**.
- That qualifier is load-bearing. Never run a blanket codemod: check the enclosing context first.
  Chains legitimately survive in Vue `onMounted`, DOM and extension event listeners,
  `MutationObserver` callbacks, and `init(): void` methods; and as behaviour, not style, in a
  `.catch()` supplying a default inside a `??` chain, a `.catch()` on one member of `Promise.all`
  so one failure doesn't sink the batch, a two-arg `.then(onOk, onErr)` settle-to-Result adapter,
  and `new Promise(() => {})` sentinels that never resolve during navigation teardown.
- When a call must be fire-and-forget from a synchronous context, write
  `void (async () => { … })()` with `try`/`catch` inside, not a `.catch()` tail.

## Design

- When something owns state or varies in behaviour — services, repositories, gateways, cached-resource
  wrappers, anything with injected dependencies — and the abstraction checklist above passes, use a
  class and the named pattern that fits: Template Method, Strategy, Repository, **Singleton** (one
  owner per concept: a single client, config or cache instance, not module-level mutable state),
  **Factory / Abstract Factory** (branching construction, so call sites stay free of `switch`).
- A pattern earns its place by removing duplication or a conditional, never as decoration. Prefer
  composition and constructor injection to inheritance chains and to singletons reached by import.
- Pure transformations stay plain functions. A class of only static methods is a namespace with
  ceremony — no polymorphism, harder to tree-shake, more awkward to test. Prefer classes that *call*
  pure functions.
- DRY / SOLID / minimum surface: reuse before writing; one owner per concept, so state and derived
  data are not recomputed per consumer; prefer deleting to adding. Dead exports, incomplete barrel
  files, and pass-through wrappers that add nothing get removed, not migrated.
- A class that has grown several unrelated responsibilities is split into collaborators in their own
  files, not sectioned off inside one file.

## Lint and formatting

- If a repo has an ESLint config, it is the single source of truth for style. Don't add Prettier, don't
  turn on `formatOnSave`, and don't hand-format code to taste.
- Fix style by running the repo's lint script with `--fix`, never by reformatting manually.
- Match the surrounding code's existing idiom rather than imposing a different one. This does **not**
  extend to comments — existing comments in a file are never a reason to add more; see Comments above.

## pnpm

- In a workspace with a `catalog:` block in `pnpm-workspace.yaml`, package manifests reference
  `"catalog:"` instead of hardcoding a version.
- `pnpm ci` is pnpm's own install builtin. To run a script named `ci`, always write `pnpm run ci`
  (same care for any script whose name collides with a pnpm builtin).

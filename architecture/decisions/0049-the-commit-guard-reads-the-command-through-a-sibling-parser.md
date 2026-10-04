# 0049 — The commit guard reads the command through a sibling parser

Status: proposed · 2026-10-04

## Context

[0035](0035-attach-guards-the-direct-commit.md) point 1 says the guard `.construct/commit-guard.mjs` "is ESM, imports
only `node:` builtins and spawns only `git rev-parse`". The shell parser that turns the one command line into git
invocations (`scanCommand`, `gitInvocation`, `walkCommands`) lived inside the guard, beside its `main` and its exit
listener. A second hook that has to read the same command line, the mutation-revert hook, would have had to copy it.

## Decision

1. **The parser is its own carrier, `.construct/shell-parser.mjs`**, from `templates/attach/_construct/`, written by
   attach beside the guard, recorded in `.construct/attach.json` with its hash and removed by detach like every other
   file attach created. It exports the parser and nothing else; it registers no exit listener and decides nothing.
2. **The guard imports two kinds of module: `node:` builtins, and its sibling `./shell-parser.mjs`.** The sibling is
   loaded by a dynamic `import()` inside the checked call, after the exit listener that defaults the verdict to a
   refusal is registered, so a missing or unloadable parser ends in one line on stderr and exit 2, never in a call
   that continues. It still spawns only `git rev-parse`, and neither file imports anything outside `node:` and the
   sibling.
3. This supersedes the sentence "imports only `node:` builtins" of 0035 point 1 and nothing else. The rest of 0035
   stands as written.

## Consequences

- attach writes eleven files instead of ten, and detach on a repository with none of their directories removes 19
  paths instead of 18; the CLI reference and the attach guide say so.
- A repository attached by an earlier version has a guard with the parser inside it and no `shell-parser.mjs`; that
  guard keeps working, because it does not import the sibling.

## Enforced by

- L3 tests: `tests/commit-guard-parser.test.ts` removes the parser and asserts exit 2 with one stderr line for a commit
  and for an ordinary call; `tests/shell-parser.test.ts` holds the parser's exports and that importing it registers no
  exit listener; `tests/commit-guard.test.ts` runs unchanged over the guard installed with its parser;
  `tests/attach.test.ts` and `tests/detach.test.ts` hold the written and removed sets.
- `pnpm contract:bump` on `paths.attach.writes`.
- [security-invariants.md](../security-invariants.md) rows on the commit guard name both source files.

## What would reverse it

A host that refuses a hook whose file imports a relative module, or a second consumer of the parser that needs a
shape the guard cannot share, which would put the parser back inside each file that reads it.

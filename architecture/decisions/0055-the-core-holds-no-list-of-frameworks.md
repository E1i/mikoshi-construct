# 0055 — The core holds no list of frameworks

Status: accepted · 2026-10-08 · owner decision D-31 (probe #536)

## Context

Probe #536 ran the Atlas on foreign repositories and found discovery missing relations wherever a
stack the core did not expect was in use. The cards that would have answered it by naming more
frameworks in the core (#699, #700) were dropped. The owner decided the opposite direction, recorded
as D-31 in the owner's decision file, and the cards that carried it out (#702, #703, #704) have since
merged. The decision itself lived only in that file; this record states it in the repository.

## Decision

1. **The core of discovery holds no list of frameworks.** No module outside a named adapter branches
   on a framework, a library or a file extension that belongs to one stack, and no module keeps a
   table of stacks to recognise.
2. **Only the law and named adapters know a stack.** The law is stack-agnostic: every tracked file is
   a node, and a file no adapter can read keeps its node with its relations unknown and a reason, so
   the Atlas never fails and never drops a file. What a stack means is held by adapters, each a named
   module behind one interface:
   - the import readers of #703 in `src/model/imports/`, each an `ImportReader` (`recognises`,
     `read`) listed once in `IMPORT_READERS` — `ts-js` first, `sfc-script` for the script blocks of
     single-file components second;
   - the resolver of #704, which resolves a non-relative import from the repository's own
     configuration (`tsconfig.json` / `jsconfig.json` paths, the workspace packages
     `pnpm-workspace.yaml` or `package.json` `workspaces` lists), never from a built-in map of
     package names.
3. **A stack the Atlas does not read yet is a new adapter, not a branch in the core.** What a foreign
   run leaves unknown is the list of next-adapter candidates.

## Consequences

Supporting a stack costs one adapter file and its test, and touches no core module. A repository
whose stack has no adapter still gets every file in its Atlas, with its relations reported as unknown
rather than guessed.

Reversed if a stack's relations cannot be read by any adapter behind the `ImportReader` interface or
resolved from the repository's own configuration — then the interface grows, still without a list of
frameworks in the core.

## Enforced by

Review (L1). No check reads the core for a framework name or a per-stack branch; the adapter
interface and its single registry make the rule easy to see in a diff, not impossible to break.

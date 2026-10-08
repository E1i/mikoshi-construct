# 0054 — The Atlas page replaces `graph --out`

Status: accepted · 2026-10-08 · supersedes [0023](0023-the-picture-is-a-file-you-can-open.md)

## Context

[0023](0023-the-picture-is-a-file-you-can-open.md) gave `construct graph` a `--out <path>` that wrote
the claims and the evidence as one self-contained HTML page beside the Mermaid on stdout. #534 adds
`construct atlas`, which runs discovery into the Engram and renders the Atlas page from it, and its
card says not to keep two commands that do the same thing. Two commands each writing an HTML page of
one repository's model is that case.

## Decision

1. **`construct atlas` is the page; `graph` has no `--out` and writes no file.** `graph` prints the
   Mermaid on stdout and nothing else. The page writer, its SVG serializer, the layout and edge-label
   passes under it, and the sentence about colour it rendered are deleted with it, because nothing in
   `src/` calls them any more.
2. **What 0023 required of its page and the Atlas page does, carried over, each with its check:**
   - The page is one file that fetches nothing and runs no script: no `<script`, no `http(s)://`, no
     `<link`, no `@import`, no `url(`. `tests/atlas-page.test.ts` › "fetches nothing, runs no script
     and follows the light and the dark scheme on a narrow screen" (L3).
   - A hostile entry carries no markup and no script address into the page. `tests/atlas-page.test.ts`
     › "carries no markup and no script address from a hostile document" (L3).
   - `graph`'s stdout stays the Mermaid it was, and every derived state is written in the entry's own
     words. `tests/graph-mermaid.test.ts`, against the pinned `tests/fixtures/model/three-states.mmd`
     (L3).
   - The renderer is this package's own code, with no diagramming dependency, for the size reason 0023
     measured. Review only (L1); no test reads the dependency list for it.
   - What would count as evidence the page is used stays 0023's: a request for it from someone who did
     not build it, arriving unprompted, recorded in [observations.md](../observations.md). Text only
     (L0).
3. **What the Atlas page adds, with its check:** a second run on the same commit writes the same Engram
   and the same page byte for byte, and in a repository `attach` jacked into, `git status` is as clean
   after the command as before. `tests/atlas-command.test.ts` (L3).
4. **Not carried over:** 0023's sentence that colour is the derived state and not the enforcement
   level, and its rule that nothing is written where nothing is drawn. This record claims neither for
   the Atlas page.

## Consequences

`graph --out` is gone, which is a breaking change to the recorded surface, released as a minor while
the package is 0.x. The one-structure-two-serializers split of 0023 ends: `graphOfModel` has one
serializer, `mermaidFromGraph`.

Reversed if a reader needs the claims-and-evidence picture as a file and the Atlas page cannot carry
it; then the page grows a view of it, not a second command.

## Enforced by

`tests/atlas-page.test.ts` and `tests/atlas-command.test.ts` (L3) for the page, `tests/graph-mermaid.test.ts`
(L3) for `graph`'s stdout, `contract/surface.json` through `pnpm contract:bump` for the removed
option, and review (L1) for the renderer having no dependency.

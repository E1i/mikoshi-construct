# 0057 — The Atlas page runs one hashed inline script, and its components are the agent's

Status: accepted · 2026-10-10 · replaces the first item of point 2 of 0054

## Context

The 0.43 Atlas page draws every file of a repository in one static picture: it cannot be read past a
few dozen files and nothing on it answers a click (#726). A map a reader can pan, zoom, unfold and
search needs code running in the page, which the first item of point 2 of
[0054](0054-the-atlas-page-replaces-graph-out.md) forbids ("runs no script"). The groups a reader
recognises — a billing API, a pricing module — are a judgement, and
[0015](0015-interpretation-stays-with-the-agent.md) keeps judgement with the agent; the boundaries
around them must come from the repository itself, never from a list of frameworks
([0055](0055-the-core-holds-no-list-of-frameworks.md)).

## Decision

This replaces the first item of point 2 of 0054 and nothing else.

1. **The page runs exactly one script, written into it, and loads nothing.** The script is inline,
   carries the map's data as JSON in which `<`, `>`, `&`, U+2028 and U+2029 are escaped, and its
   sha256 is the only `script-src` of the page's content security policy, beside `default-src 'none'`,
   so a second script, an injected one or a fetch is refused by the browser. Outside that script the
   page still has no `http(s)://`, `<link`, `@import` or `url(`. The quality gate's link check reads
   the page's markup and skips only the body of `<script>`.
2. **The map's top level is the contours the repository declares**: its root `package.json`, its
   workspace packages, the directories its `tsconfig*.json` references, and the directories holding a
   document that declares its own format (OpenAPI, AsyncAPI, Swagger, a json-schema.org JSON Schema).
   No directory name makes a contour. Discovery writes them as `mechanics.contours`, which takes
   `modelVersion` 6 because 5 is published ([0056](0056-a-model-field-added-before-its-version-is-published-joins-that-version.md) §2).
   More than 30 contours fold by their parent directory, so the first sight holds at most 30 nodes.
3. **The components inside a contour are the agent's.** The discovery protocol groups files into
   components, each with a name and a one-line purpose, under the Engram's top-level
   `interpretation` key, never inside `mechanics`. The CLI checks the shape (closed properties, one
   component per file), keeps the layer when it rewrites the document, and draws it; it never writes
   it. Files no component names are grouped by directory until one does.
4. **An arrow is an aggregate of found relations and nothing else**: its count, up to three
   `path:line` examples, and its crossing — `inside`, `through` the target contour's declared entry,
   `bypass` past it (a finding, drawn as one), or `direct` into a contour that declares no entry.

## Consequences

The page is no longer static HTML, and a reader whose browser runs no script sees the stage columns
and not the map. The renderer still has no dependency. Every repository's Engram may now carry an
agent-written layer that a later build must read.

Reversed if a browser that honours the policy runs anything on the page but the one hashed script, or
if the map needs a dependency to stay usable; then the map moves to its own file and 0054's "runs no
script" returns for the page.

## Enforced by

`tests/atlas-page.test.ts` › "fetches nothing, runs only the one script written into it, whose hash
the policy names, …" and `tests/atlas-page-script.test.ts` › "keeps a hostile name and purpose inside
the one data block" (L3) for point 1, `tests/atlas-gates.test.ts` › "a broken href in the page markup
turns the gate red while the script body is skipped" (L3) for the gate, `tests/model-contours.test.ts`
(L3) for point 2, `tests/model-interpretation.test.ts` and `tests/atlas-components.test.ts` › "the
clustering is an interpretation layer and the facts are byte-identical with and without it" (L3) for
point 3, `tests/atlas-components.test.ts` › "every arrow stands on a proven relation and its example
path:line is one of them" and `tests/atlas-arrows.test.ts` (L3) for point 4, and review (L1) for the
absence of a dependency.

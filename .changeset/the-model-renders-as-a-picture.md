---
"mikoshi-construct": minor
---

cli: `construct.model.json` gets its third projection — a Mermaid picture, rendered through the same
mechanism that already renders `architecture/composition/*.yaml`. `pnpm model:render` writes the
graph into `architecture/model.md`, and `pnpm model:check` — wired into `pnpm run quality` — reports
the committed block as stale when the model moves without it. Claims and hypotheses are nodes, the
facts under them are nodes, and **a fact several entries stand on is drawn once with one edge from
each of them**: that fan-in is the shape a list cannot show and the reason the projection exists. A
claim's edges carry the stage they come from, so its two `supportedBy` lists stay apart.

The renderer holds nothing of its own. Every state in it comes from `deriveModelState`, and the gate
that guards `doctor` is repeated here: a renderer that decides a state from the model — from how many
dependents a fact carries, from the level a claim declares — fails the test. A repository with no
`construct.model.json` renders a sentence saying so rather than an empty diagram, and a model that
parses and names nothing renders a different one: absence is a third reading, not emptiness.

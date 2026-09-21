---
"mikoshi-construct": patch
---

The add population is named, before anything is done about it

A live run against an adopted repository left two construct-written artifacts that do not fit it.
Neither is a conflict — the construct added them and the owner never touched them — so they read as
ours and sit there inert or wrong.

`architecture/observations.md` now records what `add` actually tests: a path absent from the tree,
with no recorded sha, that the template groups produced. There is no notion of applicability in the
classification at all. The only two conditionalities in the tool are `onlyWhenEmpty` mounts and the
`omittedGroups` they produce, and both key on the tree being empty rather than on what the tree is.

Every path the four presets produce is partitioned rather than sampled: 87 distinct paths, 37 reached
only in an empty directory, and the remaining 50 across four kinds. Of the five kinds two are already
conditional and one cannot misfit, so the population where a misfit can occur is exactly 23 paths
plus the keys merged into `package.json` — and the observed pair fell one in each of the two.

`tests/add-population.test.ts` checks the partition in both directions, so a new template either
moves the record or fails the build. No fix ships here: nothing under `templates/`, `src/sync/` or
`src/materialize/` changes.

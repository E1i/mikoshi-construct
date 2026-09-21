---
"mikoshi-construct": minor
---

A hypothesis now records the tree it was read from, not just the commit. Beside `baseSha`,
`construct.model.json` requires `baseClean`: whether the working tree the run began reading carried
no uncommitted change, before the run had written anything of its own. A construct that engrams an
interpretation off a dirty deck should say so on the record, so a SHA in the model can no longer
stand for bytes the interpretation was never formed from.

Both fields are required and neither constrains the other — a repository with files and no commit is
`baseSha: null` with `baseClean: false`. `baseClean` is a claim discovery writes about its own run,
never a measurement anything can confirm later, and hypotheses carrying different bases coexist by
design: the base is how a fresh interpretation is told from a stale one.

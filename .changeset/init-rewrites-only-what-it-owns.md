---
"mikoshi-construct": patch
---

A second `init` no longer replaces `construct.model.json` wholesale. The model is a committed record
meant to be read and edited by hand, and discovery will write hypotheses into it, so overwriting it on
every run was a way to lose authored content quietly. `init` now owns exactly the entries it wrote —
those whose `authoredBy` is `construct` — and carries everything else over untouched, which is what
decision 0013 already settled for the manifest.

For that rule to be expressible, authorship had to become uniform. Facts carry an `authoredBy` like
claims and hypotheses already did, and all three read it from one list: `construct`, `discovery` or
`unknown`, the same vocabulary the manifest uses for a discovery marker. A construct-authored entry the
preset still makes is rebuilt in the place it already held; one the preset no longer makes is dropped,
unless a surviving entry still stands on it, because a dropped fact would take referential integrity
with it. Surviving entries keep their relative order and only new entries are appended, since
declaration order in `claims` is what breaks a tie when two chains stop at the same stage.

The corollary is the thing to remember when editing the file: an entry that still says it was authored
by the construct is the construct's to rewrite. Change its author and the edit survives. There is no
force flag, no backup file and nothing that refuses to write.

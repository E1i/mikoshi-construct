---
"mikoshi-construct": patch
---

Two pointers in this repository's own markers named a file that is not here

`AGENTS.md` pointed at `docs/PLAN.md` twice — once in `module-map`, listing it among the directories
the layout table does not cover, once in `high-effort-areas`, citing a section of it beside the
discovery protocol. The file does not exist and is not tracked. Both pointers are removed and neither
is replaced: what that file held now appears to live across `architecture/decisions/`,
`architecture/observations.md` and `docs/guide/`, but that is an inference, and a marker is not the
place for one. The sentences around them stand without a destination.

Nothing else changes. Both markers carry no recorded provenance and still do.

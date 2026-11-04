---
"mikoshi-construct": patch
---

A card's own changeset no longer counts as a change of every layer, so with `BUS_RERUN=by-layers` a merge updates only the open pull requests its other files reach.

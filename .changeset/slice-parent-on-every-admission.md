---
'mikoshi-construct': patch
---

cli: a slice card gets its `parent` on every admission, not only when intake cuts it. A card named `<base>-slice-<k>`, admitted with `--admit`, amended or moved, carries `parent` (`card`, `part`, `of`) on its `card.admitted`, derived from the card lines the bus holds: a stub card named `<base>`, else the lowest sibling number. A slice name and part that two cards carry gets no parent, and intake says so. The bus runs the slice-parent backfill itself, once: while it holds no `slice.parents.backfilled` event and a slice card without a parent, the tick records that event, and never again after.

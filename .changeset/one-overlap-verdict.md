---
'mikoshi-construct': patch
---

The launch node reads one overlap verdict per tick. `OverlapVerdict` in `scripts/nodes/launch/overlap.ts` holds what each card overlaps and on which path. The candidate loop, the skip log and the start gate all read that one verdict. Before this, the skip log worked overlaps out again from the bus, so it never saw a card chosen in the same tick. When two queued launches share a file, the one first in start order goes ahead and the other waits on `overlap with the session of #N on <path>` when its lease comes up. Before, both started. A card whose launch is already queued is no longer logged as an overlap with itself.

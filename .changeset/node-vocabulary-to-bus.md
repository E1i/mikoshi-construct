---
'mikoshi-construct': patch
---

The node vocabulary moves down into `scripts/core/node.ts`: `TREE_LEFT`, `LIVE_REVIEWER`, `DRY_RUN_ACTOR`, `WINDOW_ACTOR`, and the live-verdict pair `firstLiveVerdict` and `NoLiveVerdict`, which the merge and update workers both read. Every importer reads them from there, and the review, merge and window files they left re-export none of them. The ratchet rows `boundary:node-close->node-review`, `boundary:node-merge->node-review`, `boundary:node-restart->node-review` and `boundary:node-update->node-merge` fall to none and `boundary:node-restart->window` from 2 to 1; no row grows, `gate:bus` included.

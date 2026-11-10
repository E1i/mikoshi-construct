---
'mikoshi-construct': patch
---

The law registry stops counting a review session as witnessed alive when no witness runs the review node. The registry gains the `supervisor` site, `scripts/supervisor/stalled-sessions.ts`, with a cell for every law; its Z7 cell is witnessed by the case #1792 settled: a live review session whose only stale signal is the context reading is not sent SIGTERM. A law cell is now green only when its witness calls a function of the site's own module, measured by V8 coverage during the run. Every cell whose witness never called its site, Z7 × review among them, is a gap of #1811, node-witnesses-call-their-node, as are the cells that named the merged #1777. `contract/factory.json` records the new site and cells, and `contract/ratchet.json` the new gap rows.

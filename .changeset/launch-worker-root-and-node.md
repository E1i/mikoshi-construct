---
'mikoshi-construct': patch
---

The launch worker is now split into its composition root and its node. `scripts/nodes/launch/launch-root.ts` is the entry `bus:launch` starts: it wires the starter ports, the ladder steps and the report readers. `scripts/nodes/launch/launch-worker.ts` keeps only the launch node. Behaviour does not change. The file no longer goes over the line threshold, so its entry leaves `contract/ratchet.json`.

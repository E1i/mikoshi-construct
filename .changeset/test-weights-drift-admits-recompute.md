---
'mikoshi-construct': patch
---

After a merge the bus measures the latest green main run's whole-file test weights against `scripts/ci/test-weights.json`. When the drift passes 30% of the longest shard, it computes the new table itself and admits one S recompute card. The launch writes that table into the card's tree before the session starts, so the card session only commits it and needs no network.

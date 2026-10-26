---
"mikoshi-construct": patch
---

factory: `construct-factory --mode window` now revokes the ghost-protocol shard on a real bus and exits 0. The revoke was recorded under an actor the bus does not accept, so on a live install merge went off while the shard stayed open until its term and the switch exited 1. The mode now records `shard.revoked` as `policy`: a narrowing of what the factory may do, never a word of the owner.

---
'mikoshi-construct': patch
---

Who decides a stop under a window shard now comes from one table, `STOP_KINDS` in `scripts/policy/shards.ts`: each stop kind carries a risk level, and only an R1 kind (the version pull request, the npm stage, security-invariants, `.claude/` config, owner-merges, workflows, a dropped witness) waits for the owner; every other kind, among them an outside-touches stop and a plain agent question, is the window's to close. A witness moved to another card or into the node-contract-suite is no longer read as a dropped witness, so the window closes that stop under a shard instead of refusing it as the owner's.

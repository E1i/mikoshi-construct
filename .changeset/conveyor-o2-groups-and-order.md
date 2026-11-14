---
'mikoshi-construct': patch
---

The bus groups open pull requests by the paths they actually change. `scripts/core/order/overlap.ts` decides when two path sets overlap: they share a path once derived registries are removed, or they meet the same declared contention area. `group.ts` turns that into groups, and `turn.ts` folds the new `pr.ordered` event into the `pr_order` projection and derives `turnOf` for each group. The supervisor writes `pr.ordered` once per life of a pull request, when it first reaches pass + green. It also computes and counts `needsUpdate` and `needsVerification` in shadow; nothing acts on them yet. `importClosure` moved from the supervisor to `scripts/core/import-closure.ts`.

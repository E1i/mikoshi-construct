---
'mikoshi-construct': patch
---

The round limit decision readers move down into `scripts/policy/decisions/read.ts`: `continueFixesDecisionOf`, `namesPrAtHead`, `namesPrAtHeadUnder`, `observedHeadsOf`, `ALLOW_MERGE`, `decisionUnder`, `headsWithTheSameDiff`, `headsOf`, with `CleanUpdate` from the update node and `OWNER_EVEN_UNDER_THE_DECISION` from `scripts/policy/policy.ts`. `cleanUpdatesOf` moves from the update node into `scripts/policy/round-limit-decision.ts`. Every importer reads them from their new owner, and the files they left re-export none of them. The ratchet rows `boundary:decisions->rules`, `boundary:rules->node-update` and `boundary:window->node-update` fall to none; no row grows.

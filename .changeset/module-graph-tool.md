---
'mikoshi-construct': patch
---

The module graph knows a third status, `tool`. A tool sees every module and is not part of the architecture graph: its own imports are never a violation, it is in no cycle component and no `may_use` may name it, and an import into it is a violation with the reason `into-tool`. The contract generator under `scripts/contract/` becomes the tool `contract-generator`; `scripts/contract/contours.ts`, the one file `scripts/ladder/handoff.ts` and `scripts/ladder/verdict.ts` import at runtime, stays in the undecided `factory-contract`. Twenty-two `boundary:factory-contract->*` rows vanish from `contract/ratchet.json`, 56 violating imports in all; no row is added.

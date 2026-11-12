---
'mikoshi-construct': patch
---

The boundary ratchet now reads an ownership move the way D-510 states it. A grown `boundary:<from>-><to>` row passes without the owner when the card changes file ownership in the module spec, the total of violating imports does not grow, and every violating import in the row existed on the commit the card branched from — whether or not it was a violation there. Until now only imports that were already violations on that commit were held, so an import inside one module that a move turned into a cross-module one, as `ports` → `ports-adapters` on the head of PR #1578, read as new. An import is still identified by its source file and what it imports; a new or swapped import stays the owner's decision.

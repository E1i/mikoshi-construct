---
'mikoshi-construct': patch
---

Internal: the session module now owns the six window, launch, restart, port and quality files it runs on (`eddies-measure`, `handoff-check`, `continuation`, `chain-process`, `ports/result`, `quality/lock`) and exposes them in its contract. Four boundary rows of the ratchet are gone, and `window->node-restart` falls from 5 to 4. Behaviour is unchanged.

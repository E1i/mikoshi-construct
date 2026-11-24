---
'mikoshi-construct': patch
---

The window's `amend` request now takes the bus contract from `RequestContext` instead of importing it. `WindowRequests` gets the contract from the composition root (`scripts/supervisor/composition.ts`, through `scripts/supervisor/run.ts`), so `scripts/window` no longer imports `scripts/core/bus-adapter.ts`. The measured window → bus edge falls from 39 to 38 imports. A request runner built without the contract refuses `amend` and says why.

---
"mikoshi-construct": minor
---

templates: `/implement` gains an eighth status, `stopped`, for a run stopped from outside before it returned. Its ledger entry must carry `stopReason`, either `environment` or `human`. A ledger entry may also name where its token figure came from with an optional `tokensSource` (`runtime`); without it, the figure is the Workflow tool's own report. `construct cost` reads the following as malformed: a stopped entry without a reason, a reason on any other status, and a `tokensSource` outside that list.

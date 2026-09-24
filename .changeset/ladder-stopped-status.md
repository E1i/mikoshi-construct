---
"mikoshi-construct": minor
---

templates: `/implement` gains an eighth status, `stopped`, for a run stopped from outside before it returned. Its ledger entry must carry `stopReason`, either `environment` or `human`. `construct cost` reads a stopped entry without a reason, or a reason on any other status, as malformed.

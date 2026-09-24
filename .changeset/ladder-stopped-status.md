---
"mikoshi-construct": minor
---

templates: `/implement` gains an eighth status, `stopped`, for a run stopped from outside before it returned. A ledger entry that ended without passing carries a `cause`: `stopped` takes `environment` or `human`, and `failed` takes `environment` or `task`. `construct cost` reads the following as malformed: a cause that belongs to another status, a cause on any other status, and a stopped entry with no cause. A failed entry with no cause reads as `not recorded`, so entries written before the field are kept as they are. A ledger entry may also name where its token figure came from with an optional `tokensSource` (`runtime`); without it, the figure is the Workflow tool's own report.

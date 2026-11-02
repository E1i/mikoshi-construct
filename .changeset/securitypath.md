---
"mikoshi-construct": patch
---

The `architecture/owner-merges.md` that `construct init` writes now puts the sandbox settings of the bus sessions (`scripts/ports/shift-settings.ts`, `scripts/ports/isolation.ts`) under `security-invariants`, so the owner merges a change to them under every shard. It also says that the owner merges a pull request that changes the table itself, whatever the table says. The bus enforces that last rule on its own, so a pull request is never judged by the row it replaces.

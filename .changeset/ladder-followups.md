---
"mikoshi-construct": minor
---

templates: the `/implement` ladder no longer asks the harness agent to report a witness's `command`. Since a reported witness is matched to the brief's by its criterion and `ranSha256`, the field decided nothing; the verify prompt, `.claude/agents/harness.md` and the verdict schema drop it. A contract check is declared only when `harness.contractCheck` is a non-empty string, so an `undefined`, `null` or numeric value leaves every harness prompt unchanged instead of asking for a check named `undefined`. A red contract check's reason now names the command and its exit code (`pnpm contract:bump exited 1`), followed by its last lines when it reported any, so a check with an empty excerpt no longer hands the next implementer an empty reason.

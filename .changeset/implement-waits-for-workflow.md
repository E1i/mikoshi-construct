---
"mikoshi-construct": patch
---

The generated `/implement` skill tells the session not to end its turn after launching the ladder's Workflow: it waits in the same turn with Monitor until the run completes, so a headless session no longer ends the run it started.

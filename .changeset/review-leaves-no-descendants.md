---
'mikoshi-construct': patch
---

A review session no longer leaves a process writing into its review tree after the review. While the session runs, the reviewer samples the process table for the session and every process descending from it. When the session ends, the reviewer waits for those processes to exit before it hands the tree back for removal, and a process still alive after the wait gets SIGTERM, then SIGKILL. This closes the `tree_left` case where pnpm wrote `pnpm-lock.yaml` into a review tree a minute after the tree was removed. The Z1 × review cell of the law registry is now a witness, not a gap. Its witness proves both halves of Z1 on the review node: a restart does not signal a live review session, and no descendant of a finished review session is alive when its tree is removed. `contract/factory.json` records the cell and `contract/ratchet.json` drops the `Z1:review` gap row.

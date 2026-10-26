---
"mikoshi-construct": minor
---

The CI workflow `construct init` writes now ends with a `required` job that waits for every other job and fails unless each of them succeeded. A branch rule or a merge tool can require that one check, and it stays the right check when jobs are added to the workflow.

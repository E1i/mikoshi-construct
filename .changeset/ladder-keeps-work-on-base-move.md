---
"mikoshi-construct": minor
---

The `/implement` ladder in a generated project keeps the finished diff when the base moves under a verified attempt: a clean rebase re-runs only the witnesses whose paths the base change touches plus the harness, a conflict reworks only the conflicting hunks, and a diff that does not apply starts a fresh attempt on the same rung. The run stops with `base moved` only after the base moved more than twice.

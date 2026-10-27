---
"mikoshi-construct": patch
---

factory: a merge task's key now carries the sha of the pull request body, so a task withdrawn on the body (`decision_unread`, `no_matrix_count_line`) is queued again under a new key once the body is edited, and the `board.alarm` raised for the withdrawal names that task key.

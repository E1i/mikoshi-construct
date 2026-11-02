---
"mikoshi-construct": patch
---

An answer session that ends with no new commit, no owner question and a clean tree no longer leaves the card standing silently. Before, the bus answer node stopped the card with `fault`. For a question, or a card without a pull request, nothing followed. For a pull request, the third such stop raised only a `board.alarm`. Now the node records a `left_nothing` denial that names the session and the count of empty answers, and the bus answers the card again. The third empty answer in a row on one task, at the review round limit of 3, stops the card with `question.owner` and opens an owner wait that names the cause. The same happens to an empty answer that would be the task's third failure in a row, counting failures of any kind; the wait then names both counts.

Other answer failures, such as an answer that leaves uncommitted changes or a card tree that cannot be recreated, are unchanged: at the third failure in a row they still stop the task with `fault` and raise a `board.alarm`.

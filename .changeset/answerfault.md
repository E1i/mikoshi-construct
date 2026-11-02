---
"mikoshi-construct": patch
---

An answer session that ends with no new commit, no owner question and a clean tree no longer leaves the card standing silently. Before, the bus answer node stopped the card with `fault` and nothing followed for a question or a card without a pull request, and for a pull request the third such stop raised only a `board.alarm`. Now the node records an `answer_failed` denial naming the session and the attempt, and the bus answers the card again. The third empty answer in a row on one task, at the review round limit of 3, stops the card with `question.owner` and opens an owner wait that names the cause.

A retried answer is not run while the card's latest turn is an owner question nobody has answered yet: the node records a `held_for_owner` denial, withdraws the task and starts no session.

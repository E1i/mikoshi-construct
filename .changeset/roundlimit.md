---
"mikoshi-construct": patch
---

A pull request at the review round limit can now go on with its fixes. The owner decision `continue-fixes PR #N at <head>` queues an answer task on that head, carrying the review's findings and the card's current body. The next push gets a review, and the pull request merges only after that review passes. A changes review on that push closes the rounds again, so the next step is a new decision. Before, the only answers to the round-limit question were allow-merge, a re-cut or closing the pull request, because the answer queue stayed closed whatever the owner said. The round-limit wait now names `continue-fixes` beside the other choices.

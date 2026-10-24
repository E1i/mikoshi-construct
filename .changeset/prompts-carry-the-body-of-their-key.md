---
'mikoshi-construct': patch
---

bus: a review prompt now carries the card body whose sha its task key names, read from that `card.admitted` event, not whatever body the projection held when the review started, so a review queued just after an amend no longer reads the body before it. An answer round on a `changes` verdict that GitHub shows but whose `review.recorded` the bus does not hold yet waits a tick, counting no failure, instead of answering with no findings and reading an older verdict off the pull request.

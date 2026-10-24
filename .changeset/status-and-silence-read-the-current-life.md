---
'mikoshi-construct': patch
---

factory: the PR status step in `bus:run` reads the steps it posts one at a time instead of holding a read open across the GitHub post, so a write another bus process commits meanwhile no longer ends the step with «database is locked» and «the status step broke and recorded nothing»: its writes wait on the bus with the same busy timeout as the workers. The supervisor judges a card silent by the beats of its current life only: a card whose latest `card.started` or `card.continued` is later than its last session heartbeat is measured from that start, so a new session is no longer judged silent seconds after it starts by the last beat of the previous one.

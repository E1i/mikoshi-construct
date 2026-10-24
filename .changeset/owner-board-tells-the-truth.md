---
'mikoshi-construct': patch
---

factory: the owner board no longer loses or refuses what it should show. A card's merge leaves its open decision questions open; they still close when the card is closed or dropped. `bus:request owner.wait.close` now closes a `W` wait as well as a `Q` one. An owner wait to check the proof mechanism, which names a pull request and no command, is opened instead of rejected. A session the launch node stops by fault raises a `board.alarm` naming its launch task, so a window requeue of that task is accepted, and a requeue the bus rejects is answered as refused, not done.

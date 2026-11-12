---
'mikoshi-construct': patch
---

A `card.started` that the reducer rejected no longer counts as a live session. Before this, `owner.launch` on such a card was refused because the card supposedly "runs the session started at event N", even though no process ran on its tree. An `owner.stop` of a session whose process is gone now has the launch node record `card.session.ended`, so the card can be launched again instead of waiting for a stop that never comes. This also holds when the card has already left the running state. Window-started sessions, which carry no process id, are not affected.

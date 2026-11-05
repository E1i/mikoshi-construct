---
'mikoshi-construct': patch
---

The live-session guard now sees a client that runs under its version as its process name, such as `2.1.318`, as well as one named `claude`. A card tree with such a session in it is no longer parked or removed, the answer node holds a card whose tree has one, and the session load reading counts those sessions and says so in `producedBy`. The answer node's own copy of the lookup is gone, so the two readers use one function.

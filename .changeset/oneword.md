---
"mikoshi-construct": patch
---

`construct-factory --mode ghost-protocol` on the owner's word is the only word the factory needs: every worker it switches on runs live, merge, update, close and restart included, and the switch writes the owner decisions `allow-live merge` and `allow-live update` for the shard's term into the bus's decisions file, creating the file on a fresh factory. A closed card no longer holds a lane while close waits in shadow, and a ready pull request no longer waits for a second `construct say allow-live`. The return to window leaves no switched-off worker live, so a worker switched on later in window starts in shadow. While the owner's ghost-protocol shard is active, the merge node no longer opens an owner wait asking for `allow-live merge`; once the shard is revoked or expired it asks again.

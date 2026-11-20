---
'mikoshi-construct': patch
---

Replacing a witness the bus recorded dead is an amendment, not a downgrade for the owner. A witness is dead when the witness node recorded it unfit on the base, or recorded it contradicting its declared base (green on a base it declared red, red on a base it declared green). `intake --admit`, `intake --amend` and `bus:request amend` now admit such a replacement without opening a `witness.downgrade` wait; weakening a live witness still waits for the owner. A later green record makes the witness live again.

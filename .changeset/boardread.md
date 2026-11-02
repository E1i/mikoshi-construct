---
"mikoshi-construct": patch
---

`construct board` now groups each card under the lane the bus launches it in, the latest `lane.assigned`, not the lane it was admitted or moved into, and drops a wait from the owner strip as soon as `owner.wait.closed` is recorded, without waiting for the reducer. An owner wait with need `decision` now closes when its card is merged, as every other wait of an ended card already did.

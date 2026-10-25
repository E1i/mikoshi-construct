---
"mikoshi-construct": patch
---

A launch lease held for 10 minutes with no session started on its card now fails with the reason `launch_unstarted`, which frees the launch slot and queues the card again; before, it held the only slot until the 30-minute lease ran out. A dropped card is no longer given a lane by an admission older than its drop; a new admission after the drop lays it again.

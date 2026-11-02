---
"mikoshi-construct": patch
---

A merge of bus code to `main` no longer stops new cards from starting while the leases in flight drain. The supervisor now drains only the bus processes that still hold a lease, and the `leases.draining` record names the sha they run on. Every changed process that holds no lease, launch included, restarts on the new code at once and leases new tasks right away. A process is refused a new lease only while it runs code other than the sha the drain restarts onto. `construct board` shows each open drain: the node, the sha it drains, the sha the restart moves onto, and the deadline.

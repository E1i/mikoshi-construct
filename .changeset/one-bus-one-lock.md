---
'mikoshi-construct': patch
---

bus: `bus:bg` and the supervisor count a process as running for a bus only when it serves that bus. A process carries the `CONSTRUCT_BUS_DB` it was started with (read from its environment through `ps -E` on macOS, `/proc/<pid>/environ` on Linux); one that names another bus — a supervisor started from an installed package for a probe, say — no longer holds this bus's lock, is not left alone in its place, and is never signalled when this bus stops its own instance. A second supervisor of the same bus is still refused, and a process whose bus cannot be read still counts for every bus.

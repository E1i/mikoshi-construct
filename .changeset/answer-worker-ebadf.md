---
'mikoshi-construct': patch
---

The answer node no longer dies with `EBADF` when a client run is aborted while the client is still writing. It closed its log files on the abort, and the next output the client sent was written to a closed descriptor. Output that arrives after the abort is now dropped, and the worker keeps running.

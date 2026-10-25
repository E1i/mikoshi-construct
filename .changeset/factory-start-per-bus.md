---
'mikoshi-construct': minor
---

factory: `construct-factory` in a repository other than the factory's own checkout starts over that repository's bus, `~/.construct/<repo-id>/bus.db`, even before that bus exists and while another factory runs over `~/.construct/bus.db`; until now it fell back to the machine bus, found the other factory's processes, start locks and pid files there, and started nothing. A process counts as already running only when it serves the same bus, a review worker's pid file is honoured only for a worker of that bus, and the command exits non-zero when it started nothing for its bus and found nothing proven to run over it. A running process whose bus cannot be read is still left alone and named, but no longer counts as this bus's factory being up.

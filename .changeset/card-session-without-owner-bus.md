---
'mikoshi-construct': patch
---

factory: a card session the factory starts no longer inherits `CONSTRUCT_BUS_DB`, so a session working in another repository cannot write into the bus that launched it; the step after the session that opens its pull request still runs on the launching bus. Inside a repository, a `CONSTRUCT_BUS_DB` that names a bus under `~/.construct` belonging to another repository — neither this repository's own bus nor the machine bus `~/.construct/bus.db` — is refused, and the built bus intake exits `1` with the reason and writes nothing. A path outside `~/.construct`, and the bus the supervisor pins for a worker started outside any repository, are still taken as named.

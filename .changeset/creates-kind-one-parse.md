---
"mikoshi-construct": patch
---

cli: `construct intake` reads a `creates` entry written as `<path> (ghosts)` or `<path> (plain)` as the path it creates, the same way the shift guard does, and refuses any other form (`--admit` marks it `unclear: creates`) instead of treating the whole entry as a path that does not exist

---
"mikoshi-construct": patch
---

`construct-intake` no longer creates a bus. Run from a repository or worktree with no bus at the path it resolves, it refuses with exit `1`, creates nothing and assigns no number, and names what to run first: `construct-factory` or `construct attach`, or a bus named in `CONSTRUCT_BUS_DB`. Before, it opened an empty bus there and numbered the card against it. A bus named in `CONSTRUCT_BUS_DB` is still created.

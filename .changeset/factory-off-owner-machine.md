---
"mikoshi-construct": patch
---

`construct board`: the board reads the bus of the repository `--dir` names, at `~/.construct/<owner>--<repo>/bus.db`, where `<owner>/<repo>` comes from that repository's git remote (`origin` first; a repository without a remote gets a local id of its own). A foreign repository no longer shows another repository's lanes and cards. A machine-wide `~/.construct/bus.db` from before is still read until the repository has a bus of its own; `CONSTRUCT_BUS_DB` still names a bus outright.

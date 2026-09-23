---
"mikoshi-construct": patch
---

The detected facts that `soulkill`, `inspect`, `capture` and `init` print label the Node major as `CLI runtime` and say it is the Node running construct, not something read from the repository. The line used to read `Runtime`, which looked like a fact about the project.

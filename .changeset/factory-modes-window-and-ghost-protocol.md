---
'mikoshi-construct': patch
---

`construct-factory` now takes a mode. A fresh factory starts in WINDOW, with the review, launch, answer and witness workers on and merge off, so a human merges; `construct-factory --mode ghost-protocol [--hours <n>]` switches every worker on and merges under a window shard for that term, and needs an unused owner word `ghost-protocol <n>h` from `construct say`, without which it switches nothing and prints the command to run. At the end of the term the supervisor returns the factory to WINDOW by itself; `construct-factory --mode window` returns sooner and revokes the shard. `construct-factory --live <worker>` makes a queue live on an owner word `allow-live <worker>`, and `--shadow <worker>` returns it to shadow.

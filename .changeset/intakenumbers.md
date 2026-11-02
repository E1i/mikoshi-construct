---
"mikoshi-construct": patch
---

`construct intake --dry-run` is now refused while a bus exists on the machine and this entry cannot reach it, for `--draft` and for `--admit`, with the same line the write prints. Before, the dry run went through without the bus's cards and could print a number the bus already holds. With no bus on the machine the dry run is unchanged.

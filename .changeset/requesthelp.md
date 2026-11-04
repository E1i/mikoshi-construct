---
"mikoshi-construct": patch
---

`pnpm bus:request` with `--help` or `-h` anywhere in its arguments prints the usage, exits 0 and leaves the bus untouched. Before, a `--help` after a kind wrote a real request, which the bus then answered.

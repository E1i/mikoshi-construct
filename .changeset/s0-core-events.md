---
"mikoshi-construct": patch
---

cli: `construct intake`, `construct board` and `construct cost` read the bus event names and the bus database path from one shared module instead of each holding its own copy; every event string and the default bus path stay byte-identical, so nothing a command prints, writes or reads changes

---
"mikoshi-construct": minor
---

cli: every command refuses a flag it does not declare, and `init --preset`, `init --ai`, `init --review`, `attach --ai` and `mutate judge --format` refuse a value outside their options, before anything is read or written: the usage is printed, stderr names every unknown flag as it was typed (or the flag, the value and every allowed one), and the exit code is 1. A script that passed a misspelt or unsupported flag and had it silently ignored now fails; drop or correct the flag. `contract/surface.json` records the options of each enumerable flag, as an optional field (`surfaceVersion` stays 2: a file without it records flags that had no options), and `contract:bump` reads an option removed as breaking and an option added as additive. Previously `mutate judge --format junit` was read as the default Vitest JSON and reported the report as not JSON; it is now refused naming `vitest-json` and `junit-xml`.

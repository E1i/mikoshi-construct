---
'mikoshi-construct': patch
---

factory: a factory over a bus whose path contains `--live`, such as `~/.construct/<owner>--live-<name>/bus.db`, no longer restarts its shadow processes every few seconds. The supervisor read a process's mode by finding `--live` anywhere in its command line, and since every factory process ends its command line with `--bus <path>`, the bus path counted as the flag. Flags and script markers are now read only from the command line before the last `--bus`.

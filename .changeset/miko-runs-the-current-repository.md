---
"mikoshi-construct": patch
---

factory: the `miko` bin runs the window of the repository it is started in. `miko` with no arguments starts the window loop; `miko watch`, `miko handoff write`, `miko handoff check`, `miko request <kind>` and `miko exit` run the window's commands from the package; every other `miko <command>` is the CLI as before. In a repository other than mikoshi-construct, the handoff lives in `~/.construct/<owner>--<repo>/handoff`, the bus is that repository's own with no fall back to the machine-wide `~/.construct/bus.db`, and the loop's continue prompt names that handoff and the `miko …` commands instead of `pnpm` scripts. Before, `miko` with no arguments printed the CLI usage, and the window could only run inside a mikoshi-construct checkout.

---
"mikoshi-construct": patch
---

cli: the command-line surface (commands and aliases, flags, exit codes per command and state, format versions, the paths `init` and `attach` write, and the block markers) is recorded in `contract/surface.json` and compared with the code on every change. No command, flag, exit code or output changes.

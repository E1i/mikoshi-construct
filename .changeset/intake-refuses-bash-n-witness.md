---
"mikoshi-construct": patch
---

`construct intake` and `construct intake --admit` now run `bash -n -c` on every witness command and mark a witness unclear when the shell rejects it, naming the witness and the shell's message. The spawn lives in one module, `src/commands/intake/bash-syntax.ts`, the only file of intake the lint policy lets import `node:child_process`.

---
"mikoshi-construct": patch
---

Repository scripts only; the published CLI is unchanged. `pnpm ghosts:hash` prints the hash when started through a symlink instead of printing nothing and exiting 0. `pnpm ghosts:launch` refuses, before any worktree, branch or status row is touched, a tasks file whose `out` is not an absolute path and a `matrix` file that is missing or does not parse, naming it. `pnpm ghosts:watch` refuses an unknown flag, a flag given as another flag's value and a flag with no value, naming it; reads the session id only from the end of the row's outcome field, where the launcher writes it; and shows a report whose modification time lies ahead of the clock as `report in the future` instead of a negative age.

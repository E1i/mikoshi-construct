---
"mikoshi-construct": patch
---

`soulkill` puts the pnpm version it finds on its own `CLI pnpm` line, saying it is the pnpm on the PATH construct runs with and was not read from the repository. The `Package manager` line now carries only what was read from the repository.

---
"mikoshi-construct": minor
---

templates: `composition:check` and `composition:render` in the `package.json` that `construct init` writes now run as `node --import tsx …` instead of through the `tsx` command. The `tsx` command opens a local IPC socket, which a sandbox without local binding refuses with EPERM, so `pnpm run quality` failed inside an agent's sandboxed session. A repository already initialised keeps its scripts until you change those two lines by hand.

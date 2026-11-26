---
'mikoshi-construct': patch
---

`src/commands/ci/state.ts` and `scripts/ci/required.ts` move from the quality module to ports, and `src/commands/intake/command-word.ts` from intake to ports; all three are in the ports contract. The intake contract names its `src/commands/intake/` files one by one instead of the whole folder. The ratchet row `boundary:ports->quality` falls from 5 to 1, `boundary:ports->intake` from 5 to 3, and `boundary:project->intake` from 1 to none; no row grows.

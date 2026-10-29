---
"mikoshi-construct": patch
---

`browser-lab.mjs hands --profile-from` no longer leaves a profile copy behind for good when its session never reaches `close`: the next hands run sweeps every hands copy idle for six hours. `hands … -- close` writes to `console.json` only the console logs its own session made since its `open`, not those an earlier run left in the same evidence directory, and a close that fails writes no `console.json` and reports the failure.

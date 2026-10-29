---
"mikoshi-construct": patch
---

`browser-lab.mjs hands --profile-from` no longer leaves a profile copy behind for good when its session never reaches `close`: the next hands run sweeps every other session's hands copy idle for six hours, and passes over one it cannot remove. `hands … -- close` writes to `console.json` only the console logs its own session made since its `open`, not those an earlier run left in the same evidence directory. A close that fails removes an earlier `console.json`, writes none, reports the failure and keeps the session for another close; a close with no record of its `open` refuses rather than guess which logs are its own.

---
'mikoshi-construct': patch
---

Bus card sessions (launch and answer) may listen on the tsx IPC pipe under `/tmp/claude-<uid>/tsx-<uid>`, so an attached repository whose gate runs the tsx CLI passes its gate inside the session sandbox. No other unix socket is allowed and outbound network is unchanged; the session's isolation reads `partial` with `sandbox.network.allowUnixSockets` named.

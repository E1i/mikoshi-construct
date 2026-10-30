---
'mikoshi-construct': patch
---

Bus card sessions (launch and answer) may bind local ports on localhost, so an attached repository whose gate runs tests that listen on a port passes its gate inside the session sandbox. Outbound network is unchanged, and the session's isolation reads `partial` with `sandbox.network.allowLocalBinding` named.

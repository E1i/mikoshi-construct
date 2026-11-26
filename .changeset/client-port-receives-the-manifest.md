---
'mikoshi-construct': patch
---

Internal: the client port no longer reads the manifest or the shift settings itself. Whoever builds it hands it the default adapter and a reader of the client configuration of a repository, and the default Claude adapter is built once beside the session port. Which client each role runs, and the `construct.json` shape, are unchanged.

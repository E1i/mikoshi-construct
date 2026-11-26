---
'mikoshi-construct': patch
---

Internal: the client record symbols (`ClientRecord`, `ClientRole`, `CLIENT_ROLES`, `clientIdFor`, `clientModelOf`, `DEFAULT_CLIENT_MODEL`) are declared beside the client contract and re-exported from the manifest module unchanged, and the client port receives the manifest reader and the shift settings from whoever builds it instead of importing them. The `construct.json` shape and its reading are unchanged.

---
'mikoshi-construct': patch
---

Internal: `ClientRecord`, `ClientRole`, `CLIENT_ROLES`, `DEFAULT_CLIENT_MODEL`, `clientIdFor` and `clientModelOf` move from `src/manifest.ts` into a new product module, `src/client-record.ts`, which imports nothing. `src/manifest.ts` and the window loop read them from there. `CLIENT_IDS` stays in `src/manifest.ts` with `clientIdsWithNoAdapter`. The module is declared in the ports layer, and its lint row is generated from `declarations/may-use/client-record.json`. No ratchet row grows. Behaviour is unchanged.

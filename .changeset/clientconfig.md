---
'mikoshi-construct': patch
---

`construct.json` gains an optional `client` branch beside `sync`: `{ id, model, roles: { launch, answer, review, window } }`, every key optional, each role naming a client id. With no branch nothing changes: the default client and `auto`, and `manifestVersion` stays 6. `sync` never writes the branch and keeps it as it read it, and a repeated `init` keeps it from the previous record. The client port looks an adapter up by id (`clientAdapterById`) and by role (`clientForRole`); an id with no adapter is a refusal that names the id and the known ones, and `clientAdapter()` with no argument still returns the default adapter for every present caller. No caller selects a client from the record yet.

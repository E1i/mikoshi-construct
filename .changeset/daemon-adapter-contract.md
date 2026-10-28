---
'mikoshi-construct': minor
---

scripts: an adapter connects to the browser daemon through one file, `.construct/daemon/<name>/adapter.json`, with five fields — `extension` (a directory, optionally a build command), `prepare`, `objects`, `mechanic` and `success` — whose single source of truth is `scripts/construct/daemon-adapter.schema.json`; `node scripts/construct/daemon.mjs check <adapter>` validates an adapter against it and refuses one whose code imports `mikoshi-construct`.

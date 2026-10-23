---
'mikoshi-construct': minor
---

The package now carries the factory as built JavaScript: every module that the bus, shift, ghosts, miko, decisions and owner scripts load, under `dist/scripts/**` and `dist/src/**` at the paths they have in the repository, with the data files they read beside them. Each entry runs with plain `node` from an installed package, without tsx and without devDependencies, for example `node dist/scripts/owner/say.js "<words>"`. No command starts the factory yet.

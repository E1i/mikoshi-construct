---
'mikoshi-construct': minor
---

The package now carries the factory as built JavaScript: every module that the bus, shift, ghosts, miko, decisions and owner scripts load, spawn or read beside themselves, under `dist/scripts/**` and `dist/src/**` at the paths they have in the repository, with the data files they read copied beside them. A factory entry runs with plain `node` from an installed package, without tsx and without devDependencies, for example `node dist/scripts/bus/reducer.js`. New command `construct say "<words>"`: the owner's words, written as one unused answer into `~/.construct-owner/answers/`, the channel an owner decision is accepted from. No published command starts the factory yet.

---
"mikoshi-construct": patch
---

The first time the tool wrote into a repository on its own judgement rather than on an explicit `init`, recorded here as the manifest's `sync` branch.

The run had exactly one effect, and the interesting part is why. Both files carrying a construct block reported `unknown` — nothing records which template variant wrote them and no rendering matches the recorded hash — so sync refused to touch them, which is the rule working rather than a limitation being hit. What it did write was `tsconfig.base.json`: the file deleted from this repository by hand months of commits ago, whose removal was also struck from the manifest, so that the intent behind it no longer existed anywhere to be respected.

Deleting it again closes the loop. Because the write is now recorded, the same path reads as `removed` from here on and is never offered again. The record the manual edit destroyed has been rebuilt — not the file, but the knowledge that the construct wrote it and the owner took it out.

---
"mikoshi-construct": patch
---

cli: `construct atlas` no longer refuses its own Engram when a source file imports a file that is not a component (`.json`, `.css`, `.vue`, …): such an import is now a relation of status `unknown` with no target, so the Atlas page is written for Mikoshi itself and for any repository with such imports.

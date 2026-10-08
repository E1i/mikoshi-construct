---
"mikoshi-construct": patch
---

cli: `construct atlas` no longer refuses its own Engram when a source file imports a file that is not TypeScript or JavaScript (`.json`, `.css`, `.vue`, …), so the Atlas page is written for Mikoshi itself and for any repository with such imports.

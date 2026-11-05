---
'mikoshi-construct': patch
---

The bus now merges a fresh `origin/main` into a card branch itself and takes every owner path main changed from main byte for byte, so a card session is only ever handed a merge already in progress with conflicts in its own files, and never has to write an owner path.

---
'mikoshi-construct': patch
---

`intake --move` of a sliced stub now re-points the cards that wait on the dropped card: every open admitted card whose depends name it gets a `card.admitted` with source `amend` that depends on the slices naming it in their blocks instead. A dependent that no slice names makes the drop refused, naming each such card, and `--dry-run` prints the re-pointings it would record.

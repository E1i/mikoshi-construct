---
'mikoshi-construct': patch
---

The bus continues a card in its held tree when the changed paths came from the session's own commands (`lint:fix`, a copied template, a generator), not only from its Write and Edit calls; a change made after the session ended or outside every command it ran is still refused.

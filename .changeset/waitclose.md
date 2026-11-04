---
"mikoshi-construct": patch
---

An owner decision scoped to a card now closes that card's open decision and command waits in the same write, and a card amended through `construct-intake` closes the decision waits opened before the amend. A merge wait stays open until its pull request merges.

---
"mikoshi-construct": patch
---

`construct intake` no longer marks a vitest witness that names a test but no file as unable to be red on the base, and `intake --admit` counts the same wordings as intake for a witness that must be red on the base. The witness check that runs a card's witnesses on the base and on the head (P7) now reads the paths a witness names, the card's `creates` and the wording of a change witness through the same reader and predicate intake uses; before this, the sentence in the earlier release note that intake and P7 read the paths a witness names in the same way did not yet hold.

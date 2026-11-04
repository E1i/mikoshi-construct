---
"mikoshi-construct": patch
---

The merge node now rebuilds the check catalog itself from the tree of main after a merge that changes a test or the layer map, and when the catalog is empty; a failed rebuild leaves the catalog as it was and raises a board alarm. A 405 on a merge now keeps GitHub's response text, a head that is not up to date goes to update rather than counting as a fault, and any other 405 still stops the card, now with the text.

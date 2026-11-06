---
'mikoshi-construct': patch
---

A ready card with no live depends no longer waits behind a long chain when every lane is occupied: lane layout moves it to the least loaded lane it has no touches overlap with, when that lane holds fewer waiting cards than its own by more than the size of the moving part. A card with real depends, a card the owner moved, a parent with a dependant in its lane and a card overlapping a started card stay where they are.

---
'mikoshi-construct': patch
---

The pre-push selection and the by-layers merge policy now read a card's runs from the same source as the session: a masked layer only adds to what the changed paths select, a new file resolves through the layer map by folder and one in an unknown folder is a full run that names it, a file in two layers takes both, and a touch no explicit run covers adds its layers.

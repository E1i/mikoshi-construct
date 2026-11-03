---
"mikoshi-construct": patch
---

A card stopped with no pull request on an agent question no longer stays down for good when no window is running. The paths it asks to add to its touches keep only real files in its tree. Anything else, such as a package name, a host or a URL path, is dropped and named in the stop. When nothing is left to add, the card starts again once the owner closes its question. A stop that asks for a real path outside its touches still waits for an amend, and the amend starts it again.

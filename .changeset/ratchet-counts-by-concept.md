---
'mikoshi-construct': patch
---

The ratchet in `contract/ratchet.json` now counts each concept as one number, the sum of its sites over all files, so moving a site from one file to another without raising the sum is no longer growth.

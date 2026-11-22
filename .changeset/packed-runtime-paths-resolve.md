---
'mikoshi-construct': patch
---

The installed package now carries every runtime file and worker it opens — `contract/factory.json` and the review-planner worker among them — so review and card repair run in a consumer repository instead of stopping on `ENOENT dist/contract/factory.json`.

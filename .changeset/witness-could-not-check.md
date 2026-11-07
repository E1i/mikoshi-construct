---
'mikoshi-construct': patch
---

The witness tells "could not check" from "failed": a browser witness whose declared server never answered now records the verdict `unchecked` instead of red. It queues no answer round, it does not let the pull request merge (the witness denial names it as could not check, not red), the board shows `could not check` apart from red, and the pull request status reads `witness could not check` as pending, not `witness red`; a witness that ran and failed stays red, and events already stored keep their verdict.

---
"mikoshi-construct": patch
---

The review node keeps its depth plan when a concurrent fetch of the shared clone moves `origin/main` under it: a fetch that fails with `cannot lock ref` is retried once before the depth is planned, and any other fetch failure still fails as before.

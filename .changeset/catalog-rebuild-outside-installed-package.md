---
'mikoshi-construct': patch
---

In a consumer repository the merge node no longer runs git inside the installed package to rebuild the check catalog, which failed there with `catalog_rebuild_failed` («not a git repository»). It now rebuilds in the checkout of the repository it merges for, and when that directory is not a git checkout, or the repository carries no catalog script, it skips the rebuild and logs the reason instead of failing.

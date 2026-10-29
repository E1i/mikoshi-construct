---
"mikoshi-construct": patch
---

The prompt `daemon.workflow` gives each object's agent now says that `hands` runs with its working directory in that object's evidence directory, so a path passed to `hands`, a screenshot or a file to upload, resolves against the evidence directory and not the repository root.

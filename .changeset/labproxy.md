---
"mikoshi-construct": patch
---

The browser lab takes `--proxy <url>`, or `CONSTRUCT_LAB_PROXY` from the environment when no flag is given, and sends its own browser through that proxy at every launch, `hands` included, so a site that blocks by IP can be reached through an exit elsewhere.

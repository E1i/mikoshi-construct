---
"mikoshi-construct": patch
---

The launch queue no longer runs cards one at a time just because each names the same shared registration file: files a repository lists under `sharedAppendFiles` in `construct.json` (a path, or a prefix ending in `/**`) do not block parallel launch or chain two cards into one lane when both cards name them. An overlap on any file outside that list, or a mask that covers a listed file, still blocks.

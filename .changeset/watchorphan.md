---
"mikoshi-construct": patch
---

`pnpm miko:watch` no longer leaves the window blind after its parent dies. A watch whose parent process is gone (a `pnpm` killed by a Bash timeout) now exits and releases the `--once` cursor, and the cursor lock records its owner beside `miko-watch.db`: a next `--once` that finds the lock held by a watch whose owner is dead waits a few seconds for that watch to let go and takes the cursor over, instead of answering "another consumer already waits". A lock whose owner is alive is still refused at once, never waited for.

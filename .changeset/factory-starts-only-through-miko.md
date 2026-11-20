---
'mikoshi-construct': patch
---

The factory starts only through Miko. `miko start` runs `construct-factory --miko`, which writes `factory.started` in the bus directory and then starts the bus. Running `construct-factory` with no arguments no longer starts anything. Neither launchd agent the factory renders (`dev.mikoshi.bus` and `dev.mikoshi.factory.<clone>`) has `RunAtLoad` now. Both keep the starter alive only while that mark exists (`KeepAlive` → `PathState`), so an agent restarts a factory that Miko started and never starts one on its own. The keep-alive starter (`--hold`) does nothing until Miko has written the mark.

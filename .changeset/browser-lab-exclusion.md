---
'mikoshi-construct': patch
---

A card session of the bus now runs `node scripts/construct/browser-lab.mjs` outside the sandbox when its repository excludes that command. The session's `--settings` layer carries that one entry and no other the repository lists, and it denies writes to the script.

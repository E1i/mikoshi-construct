---
'mikoshi-construct': patch
---

A card session of the bus now runs `node scripts/construct/browser-lab.mjs` outside the sandbox when its repository excludes that command, and the lab takes its tools only from `~/.construct/browser-lab/npm-cache`, ending as unobserved when a pinned tool is missing there.

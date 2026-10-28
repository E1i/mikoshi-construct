---
'mikoshi-construct': patch
---

cli: when attach refuses a collision where some paths are not recognised, the next step now reads `Move the paths marked not recognised yourself, then run: cd … && rm -- … && npx mikoshi-construct attach …`, a command a shell runs as pasted, instead of a line whose apostrophe left a quote unterminated

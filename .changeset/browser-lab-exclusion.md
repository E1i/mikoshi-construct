---
'mikoshi-construct': patch
---

A card session of the bus now runs the browser lab outside the sandbox only as `node <home>/.construct/browser-lab/bin/browser-lab.mjs`, an absolute path outside the tree that the bus installs from the factory, and only when the repository excludes that command; a copy of the script in the tree stays in the sandbox. `construct init` writes the entry into `.claude/settings.local.json` on the machine instead of the committed settings, `construct attach` writes the same absolute entry, and the lab takes its tools only from `~/.construct/browser-lab/npm-cache`, ending as unobserved when a pinned tool is missing there. A repository attached earlier needs `construct detach` and `construct attach` to replace its recorded relative entry.

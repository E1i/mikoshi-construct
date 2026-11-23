---
'mikoshi-construct': patch
---

When the only change to `.claude/settings.local.json` is dropping the dead relative `node scripts/construct/browser-lab.mjs *` entry, `sync --apply` now reports the browser-lab exclusion as `added` instead of `held`, and `attach --upgrade` records the write. Whether the settings file was written is decided from its bytes before and after, not from the entries added.

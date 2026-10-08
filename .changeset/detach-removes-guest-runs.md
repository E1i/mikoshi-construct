---
"mikoshi-construct": minor
---

cli: `construct detach` removes the run directories the guest created inside a `.construct/browser` that already existed before attach, and leaves every entry that was there at attach; after a byte-for-byte restore of `.claude/settings.local.json` it says the original bytes came back instead of "guard entry removed". `attach` now writes the names it found in `.construct/browser` into `.construct/attach.json` as `browserHeld`, and `recordVersion` stays 2; a repository attached by an earlier build has no such list, so detaching it still leaves every run directory in a `.construct/browser` that was there at attach

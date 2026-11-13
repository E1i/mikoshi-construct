---
'mikoshi-construct': patch
---

cli: `construct answer <Q|#card> "words"` answers one open owner wait from the published CLI. It says the word into the owner channel and writes one `owner.answer` request to the bus of the repository it runs in, through the same guard-free writer `pnpm owner:answer` uses; it exits `3` and writes nothing where no bus is. That request is the only write the published CLI makes into a bus.

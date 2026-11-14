---
'mikoshi-construct': patch
---

cli: `construct-answer <Q|#card> "words"` is a bin of its own: `pnpm owner:answer` from the installed package, as `construct-intake` is to `construct intake`. It finds the bus of the repository it runs in and its owner channel, says the word and writes one `owner.answer` request. The published `construct` stays without an answer command and writes nothing into a bus.

---
"mikoshi-construct": minor
---

`construct atlas` now refuses a repository that has neither a `construct.json` written by `construct init` nor an attach record, writes nothing, and exits 1 with a line that names `construct attach` as the way in. Before this it wrote an Engram and a page under the home directory for any repository at all. A repository attached by this build runs as before: a test now holds that `construct attach` on a foreign repository leaves every tracked file byte for byte as it was, an existing `construct.model.json` included, which is what lets the Atlas run there.

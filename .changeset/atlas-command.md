---
"mikoshi-construct": minor
---

cli: `construct atlas` discovers the code a repository's git tracks, writes it into the Engram (`construct.model.json` after `init`, `~/.construct/engram/<repo>-<hash>/` after `attach`, now `modelVersion` 5) and renders the Atlas page into `.construct/`, writing no tracked file of an attached repository; `construct graph` loses `--out`, since the page to open is the Atlas.

---
"mikoshi-construct": patch
---

`construct atlas` in a repository `construct init` made no longer writes the Engram's `mechanics` into the tracked `construct.model.json`, where they could grow the file from kilobytes to megabytes. They go into `.construct/mechanics.json`, which the construct's `.gitignore` ignores; `construct.model.json` keeps its facts, claims, hypotheses, nodes and `interpretation`, and a `mechanics` block an earlier build wrote there is dropped on the next run. Discovery gives the same mechanics for one commit, so a fresh checkout rebuilds them and draws the same Atlas. An attached repository's Engram stays where it was, under `~/.construct/engram/`.

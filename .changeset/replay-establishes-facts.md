---
"mikoshi-construct": minor
---

A replay no longer demands a value the tool can establish for itself. The manifest records the owner's decisions; the detector establishes facts about the repository; a fact the manifest lacks is established at replay rather than asked for. Three real repositories could not run `sync` at all because their manifests, written by 0.1.0, carry no `compositionDir` — a directory the detector finds by looking for it. They were being told to hand-edit `construct.json`, the one action the tool's own decision record says destroys evidence of intent irrecoverably: forbidden in the documentation and required by the code.

Two boundaries make the rule safe. A value the manifest already carries is never re-detected — establishing a fact fills a gap and never corrects a record, or a replay would quietly drift from what the earlier run did. And only facts about the repository are established, never facts about the machine: `nodeMajor` and `pnpmVersion` describe wherever the command happens to be running, and re-detecting them would rewrite files nobody asked to change.

A fact is also only what the repository actually shows. Where the detector finds nothing, the replay stops and names the variable rather than borrowing the default `init` uses — in `init` that default is offered to the owner as they agree to materialise, and in a replay the same value would be a decision taken for them in silence.

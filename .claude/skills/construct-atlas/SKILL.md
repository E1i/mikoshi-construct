---
name: construct-atlas
description: Build the Atlas of this repository with its parts named — run construct discovery, which writes the interpretation into the Engram, then construct atlas, which renders the page from it.
user-invocable: true
argument-hint: [area to (re)discover, or empty for everything]
---

The Atlas is the view of the Engram, `construct.model.json`. `construct atlas` alone draws the parts the code
itself declares; the parts a reader would name come from discovery, which writes them under the Engram's
`interpretation` key. This skill runs the two in order.

1. Run the discovery that fits the repository to its end, with `$ARGUMENTS`. Where `.construct/attach.json`
   exists and `construct.json` does not, the repository is attached: run `/attached-discover`, which writes
   the components only into the Engram under `~/.construct/engram/` and nothing inside the repository.
   Otherwise run `/construct-discover`; its step on contours and components runs `construct atlas`, writes
   the components it can stand behind under `interpretation`, and writes nothing under `mechanics`.
2. Run `construct atlas` (or `npx mikoshi-construct atlas`) from the repository root. It rewrites `mechanics`,
   keeps `interpretation`, and writes one self-contained page, the one it names.
3. Report the page it names and how many components `interpretation` holds. If the first line of its output
   says no part is named yet, discovery wrote no component: say which contours it could not place and why,
   instead of reporting the Atlas as interpreted.

Write nothing outside what the discovery and `construct atlas` write. If either refuses, report its
refusal as it printed it and stop.

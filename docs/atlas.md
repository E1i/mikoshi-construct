---
title: The atlas
---

# The atlas

The Atlas is the view derived from the Engram: an interactive map of a repository, not a second model.
`construct atlas` reads the tracked files, writes the mechanics under `.construct/` (never into the tracked
model) and renders one self-contained HTML page ([CLI reference](/cli#construct-atlas)). The parts a reader
would name come from discovery, which writes them under `interpretation` in `construct.model.json`
([Getting started](/guide/getting-started#then-open-the-map-of-the-code)).

**[Open the Atlas of mikoshi-construct](/mikoshi-construct/atlas.html)**, a self-contained page outside this
site's theme. `pnpm docs:build` runs `construct atlas` from the checkout
before VitePress, so the page is rebuilt with the site.

The text that explains what the map shows:

- [Getting started](/guide/getting-started) and [INIT](/guide/init), which produce the model
- [HIJACK](/guide/hijack), where the Atlas of an attached repository stays untracked
- [The factory](/guide/factory) and [Miko's window](/guide/miko-window)
- [Architecture](/guide/architecture/atlas), the design of the Atlas itself

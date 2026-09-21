---
"mikoshi-construct": patch
---

`construct graph` shipped in 0.10.0 and was documented in the CLI reference and the README command
table, and mentioned zero times in the walkthrough a new user actually reads. Reachable is not
discoverable — the same gap the release sidebar had. Getting started now ends on the picture, which is
the payoff of the walkthrough: `init` writes the files, `doctor` reports on them, and the graph shows
what those reports are read out of.

The example is the real rendering of a repository straight after `init`, not a sketch, and the
documentation site now renders Mermaid fences as diagrams rather than as source.

It also states the two things somebody meeting the model for the first time would otherwise discover by
surprise: a repository with no `construct.model.json` draws nothing and says so, and `init` is what
creates one.

**Why a plugin and not a build-time render, decided rather than defaulted.** `vitepress-plugin-mermaid`
works outside its declared support — it names `vitepress: ^1.0.0` against this site's `2.0.0-alpha.20`,
and `mermaid: 10 || 11` against mermaid 12, pinned here to 11. That is a real upgrade risk. The
alternative, rendering to SVG at build time, removes it and ships no renderer to the client, but
`@mermaid-js/mermaid-cli` peer-requires puppeteer, which puts a headless browser in every CI run, and
the SVG becomes a generated artifact needing a writer and a staleness check.

The deciding fact is that `docs:build` runs inside `pnpm run quality`, so a VitePress upgrade that
breaks the plugin turns the harness red on the pull request that bumps it — the most visible moment
rather than an unpredictable one. The client cost is lazy: mermaid is code-split across chunks loaded
only when a diagram of that type renders, so pages without one pay nothing.

**The trigger for revisiting is written down**: if a VitePress upgrade breaks the plugin, or a second
diagram type pulls in chunks that are not lazy, render to SVG at build time instead. Migrating later
costs roughly one edit per diagram page, which is why the trigger is recorded now rather than left to
be rediscovered.

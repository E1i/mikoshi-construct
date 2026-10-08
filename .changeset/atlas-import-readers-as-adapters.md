---
"mikoshi-construct": minor
---

cli: discovery reads imports through named adapters. The TS/JS reader is the first. The second, `sfc-script`, reads the `<script>` blocks (and an Astro-style leading `---` fence) of `.vue`, `.svelte` and `.astro` single-file components, so the relations they declare reach the Engram at their own line numbers.

---
"mikoshi-construct": patch
---

**The documentation has a home: [e1i.github.io/mikoshi-construct](https://e1i.github.io/mikoshi-construct/).**

A VitePress site built from `docs/`, deployed to GitHub Pages on every push that touches it, and
named as the package `homepage` so npm links to it rather than to a README anchor. Five guide pages:
getting started (empty directory and existing repository, with the rules for what is never
overwritten), the development cycle end to end, the reasoning budget with the measured costs, the
upgrade loop, and what the tool refuses to claim — the three states, the enforcement levels, and the
difference between *verified* and *not observed*.

The upgrade loop moved out of the CLI reference into its own page, so the reference stays a reference
and the procedure has one home. The README now links the site and says v0.3 instead of v0.1.

One guard moved with it. The privacy scanner reads the documentation source and skips what a
documentation build produced from it, asserted by name rather than by ignoring the directory
silently — and on its first run it caught a home-directory path in the getting-started page.

The site is built with VitePress 2 alpha rather than the 1.x line, because 1.x depends on a vite
release covered by GHSA-fx2h-pf6j-xcff, which this repository's dependency audit blocks at high
severity. The alpha depends on the same vite major the repository already has, so there is one vite
in the tree, no advisory, and no trust-policy exemption. It is a development dependency that produces
static HTML and ships in no package.

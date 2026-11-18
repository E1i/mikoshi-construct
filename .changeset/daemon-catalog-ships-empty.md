---
'mikoshi-construct': patch
---

templates: the browser-lab skill now declares `daemon: BROWSER_LAB` and `daemon-sketch: hex-iris` in its frontmatter, so the board's DAEMONS cell lists it as installed. The daemon's mutations come from the adapters that are actually present: each `.construct/daemon/<name>/` directory holding an `adapter.json` is mutation `ver_<name>` of BROWSER_LAB. The `daemon-mutations` frontmatter field is no longer read.

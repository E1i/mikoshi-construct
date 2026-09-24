---
"mikoshi-construct": minor
---

`init` refuses a Node preset in a directory whose root has another ecosystem's manifest (`go.mod`, `Cargo.toml`, `pyproject.toml` and others) and no `package.json`. It names the preset and the manifest, writes nothing and exits 1. Until now it wrote the whole Node baseline into a Go repository and exited 0. `soulkill` reports the manifests it found on a new `Other stacks' manifests` line, and `--json` carries them as `existing.foreignManifests`.

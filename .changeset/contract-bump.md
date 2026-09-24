---
"mikoshi-construct": minor
---

contract: CI computes the bump a pull request's change to the public surface requires and fails when the declared bump is weaker. `contract/surface.json` gains `surfaceVersion` 2 and records the JSON type of each `--json` sample's root beside its key paths. `pnpm contract:bump` compares the surface at the latest release tag reachable from `HEAD` with the surface at `HEAD`: before 1.0, additions require at least a patch changeset and a breaking change at least a minor one. No command-line behaviour changes.

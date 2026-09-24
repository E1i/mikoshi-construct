---
"mikoshi-construct": minor
---

cli: `doctor --json`, `sync --json`, `sync --apply --json`, `cost --json` and `soulkill --json` carry a top-level `schemaVersion` (1), the version of that key set; `cost`'s `version` and `sync`'s `fromVersion`/`toVersion` still name CLI versions. With no `construct.json`, `doctor`, `sync` and `sync --apply` under `--json` now print `{ "schemaVersion": 1, "state": "no-manifest" }` instead of `null`, with the same exit code `1`: a script that tested for `null` tests for `state` being `"no-manifest"`. The key paths each of these outputs prints in each state are recorded in `contract/surface.json`.

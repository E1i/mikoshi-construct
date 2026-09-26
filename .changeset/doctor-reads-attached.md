---
"mikoshi-construct": patch
---

cli: doctor reads an attached repository (no construct.json, `.construct/attach.json` present) as `state: "attached"` with the harness command and its coverage state, instead of reporting no-manifest.

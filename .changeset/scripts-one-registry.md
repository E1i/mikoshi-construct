---
'mikoshi-construct': patch
---

`package.json` is now the one registry of this repository's scripts: `pnpm contract:update` derives the `CONTRIBUTING.md` table's rows and the `scripts` section of `contract/surface.json` from it, and the published manifest gains the `scriptsOutsideTheHarness` field.

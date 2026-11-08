---
'mikoshi-construct': patch
---

Each concept in `contract/factory.json` now names its owner's export in an `ownerExport` column, beside `owner`. Generation fails when a concept marked `ownerExists` has an owner file that does not export that name, so renaming the owning function no longer goes unnoticed. A concept whose owner is not built yet keeps `ownerExists: false` and `ownerExport: null`. The check stops at the export: it does not check that anything uses that export.

---
'mikoshi-construct': patch
---

The answer round of the pre-push gate (`scripts/ci/prepush.ts --round <head>`) no longer runs the full suite under the shared quality lock when its change would select one: it runs only the tests of the layers the change reaches, none when the change belongs to no layer, and its green line says the full suite is CI's. A card session's pre-push run without `--round` is unchanged.

---
"mikoshi-construct": minor
---

`init` and `attach` now ask how many parallel lanes the bus runs, default 3, and take `--lanes <count>` instead. `init` records the answer as `lanes` in `construct.json`; `attach` records it as `lanes` in `.construct/attach.json` and still writes no `construct.json`, so `doctor` and `sync` keep reading an attached repository as attached. A second `init` reads the recorded count and does not ask again. The bus takes its lane count from `construct.json`, else from the attach record, else 3.

---
'mikoshi-construct': patch
---

`task:close` now closes an implement card with no pull request in the bus by `--report`, as done with the report path, the way a probe closes, so a card whose order ended in a report no longer has to be moved to dropped. An implement card with a pull request still closes with `--pr` only, and `--pr` and `--report` together stay refused.

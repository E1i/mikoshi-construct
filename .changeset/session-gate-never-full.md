---
'mikoshi-construct': patch
---

A session's pre-push gate (`scripts/ci/prepush.ts`, with or without `--round`) never runs the full suite: a change with a layer runs that layer's tests, and a path with no layer runs the tests that cover it and the tests of its generator. The full run is CI's. Each gate run and each pre-push run writes one `gate.run` event to the bus (source, layered or full, reason, seconds, round, card, whether the card touches `contract/module-files.json`, test count). The bus version goes from 3 to 4 because the event catalogue grew. `construct board` shows the last 24 hours of these runs: how many there were, the share of full runs, the median time per source, and the check time per round.

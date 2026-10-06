---
"mikoshi-construct": minor
---

cli: `construct mutate judge --card <n>` appends a `mutation-judged` line — card, mutation id, outcome, whether it matched — to `--journal` (default `~/.construct/handoff/ghosts.jsonl`) after a verdict, so a task closed as verified by mutation can be checked against a mutation that ran; without `--card` nothing is written, as before.

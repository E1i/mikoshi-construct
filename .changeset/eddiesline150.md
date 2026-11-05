---
"mikoshi-construct": patch
---

A launch or answer session now reaches its context line at 150k, set by `cardContextLine` in `.claude/eddies.json` as an absolute value `warnRatio` does not apply to; with the key absent the line stays `contextLimit` × `warnRatio`. The coordinating window keeps its own line. The board's context reading divides by the real window of the session's model, from `modelWindows` in the same file, and shows no denominator for a model that file does not name.

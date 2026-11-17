---
'mikoshi-construct': patch
---

The board names what holds the head of each lane: the launch node records a `lane.held` event when a lane's
first queued card cannot start (an overlap with an open pull request, an unmerged or dropped dependency, the
machine's load), and the bus screen and `--json` show it as `laneHeads` while that card is still planned.

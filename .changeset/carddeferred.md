---
'mikoshi-construct': patch
---

`intake --move <#N> --to later` now writes `card.deferred` instead of `card.dropped`: the card keeps its number and depends, takes no lane position and does not start, a card that depends on it keeps waiting, and a move to a launch lane returns it to the queue with no new intake. The board's warning about a planned, startable card and a new line in the launch node's log state the same reason: the card at the head of the lane, `overlap with open PR #N on <path>`, or occupied slots.

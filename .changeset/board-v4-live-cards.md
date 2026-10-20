---
"mikoshi-construct": patch
---

cli: `construct board` shows only live cards in Flow and Backlog — a card with no card body, or one closed through `task:close`, is not in work, and a card dropped, merged or closed more than 12 hours ago appears in Backlog only under `--all`, which now keeps the screens instead of switching to the raw sections; Services also names the window's role record and each session's step with its pulse, a card's check matrix stands beside it in Flow, and a lost session counts as the last failure

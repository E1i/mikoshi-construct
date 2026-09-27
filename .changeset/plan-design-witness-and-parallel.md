---
"mikoshi-construct": minor
---

templates: `/plan` gains two rules. Every line of a task brief's Design, and every case a line lists, is held by a should / should-not witness pair or fixture pair; the brief's author checks Design line → witness line by line before approval and gives an unheld line a witness or removes it. Independent tasks — write contours that do not intersect, no dependency on each other's results — are planned and run in parallel by default (subagents for reviews, checks and brief preparation; separate sessions or worktrees for implementation), and a task is sequential only when it shares a write resource or needs another's result, which the plan states in one line.

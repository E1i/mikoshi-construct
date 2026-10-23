---
"mikoshi-construct": patch
---

cli: `construct board` reads one stage per card: a stopped card whose answer, review or merge task is leased shows at that task's stage and counts as live, and the Flow columns sort cards by stage, so a card in answer after a stop is no longer missing from Flow, and a card's task and its session of the same role and task show as one service tile, not two

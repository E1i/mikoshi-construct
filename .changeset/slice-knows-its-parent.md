---
'mikoshi-construct': minor
---

cli: the board tells a slice apart from a whole card. When intake cuts a card into slices, each slice's `card.admitted` carries `parent` (the parent's number and its share, k of n), and the board marks every slice `◧ k/n · из #N` in text, `--json` (`parent`, `mark`) and on the page, while a whole card carries no mark. The flow, the page header and `--json` (`tally`) count live cards apart from tasks, `14 карт = 6 задач`, where a task is a parent with all its slices or a whole card.

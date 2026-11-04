---
"mikoshi-construct": patch
---

The card dialog on the board shows a table of a card's witnesses when it has fields, one row W1..Wn with its run, test, expected head/base with the last result on the current head and what it proves, and a line for its runs. `pnpm bus:witness-backfill` parses the `Witnesses:` and `Runs:` of existing cards into fields in one event, lists every line it could not parse by card, and changes no card text; a card it did not parse keeps its prose witnesses. The services grid on the board takes a 16rem column.

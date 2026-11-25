---
"mikoshi-construct": patch
---

`construct cost` and the ladder ledger now read the bus through the card-record readings and `events-query` instead of their own SQL over `events`, `cards`, `card_bodies` and `prs`. The ended cards, spend turns, legacy lines, ladder runs and Ghost lines they report are unchanged, and the four files leave the foreign-table exception list.

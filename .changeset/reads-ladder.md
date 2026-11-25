---
"mikoshi-construct": patch
---

`construct cost` and the ladder ledger now read the bus through the owners' readings instead of their own SQL over `events`, `cards`, `card_bodies` and `prs`: cards and their bodies through the card-record readings, PRs through the pr-record readings, events through `events-query`. A card still ends on the last merged `pr.closed` of any PR the `prs` table links to it, or of its own card id, and otherwise on its last `card.closed`. `tests/cost/cheap-from-bus.test.ts` holds the replaced SQL and checks that each reading returns the same rows on one bus. The four files leave the foreign-table exception list.

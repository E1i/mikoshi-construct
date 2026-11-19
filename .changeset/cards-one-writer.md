---
'mikoshi-construct': patch
---

The `cards` table of the bus now has one writer module: linking a card to its pull request is card's own operation in `scripts/core/card-automaton.ts`, taken by the link-observed and pr-opened transitions, and the pr folds only compute the refusal and hand it over as a value. The `one-writer-per-table` contract test now holds `cards` to that one writer.

---
'mikoshi-construct': patch
---

The no-foreign-table-sql ratchet is closed. `scripts/quality/foreign-table-sql-excepted.json` is gone, and the rule now errors on every source file except the one named journal-history replay: `scripts/core/report.ts`, listed in `JOURNAL_HISTORY_REPLAYS` in `eslint.config.mjs` with its reason. The last four readers now go through the operations of the tables' owners:

- The legacy journal history reads its rows through the bus's `events` query.
- The parking reads take card bodies, their depends and card states from card-record.
- The card chain takes a card's pull requests from its callers, which read them through pr-record, and reads the events and card bodies through bus and card-record operations.
- The intake's XS whole-card reason now says "split across cards": the old wording, "cut into cards", read to the rule as SQL naming the `cards` table.

What these readers return does not change.

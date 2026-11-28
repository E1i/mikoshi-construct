---
'mikoshi-construct': patch
---

Internal: the end of the journal history, `JOURNAL_HISTORY_ENDS` and `writtenBeforeHistoryEnds`, moves from `src/card/closed.ts` into the events module. `scripts/core/declared-events.ts` writes it into the generated `scripts/core/events.ts`. `scripts/core/legacy-history.ts` now reads it from `./events.js`, so the bus imports nothing from `src/card`, and the ratchet row `boundary:bus->card-model` and its known violation are removed. `src/card/closed.ts` re-exports both names, so every importer and what `legacyHistory` returns stay unchanged. `src/card` may now reach `core/events.js` through `declarations/may-use/card.json`. Behaviour is unchanged.

---
'mikoshi-construct': patch
---

The bus event catalog and the event lists of the bus readings come from declarations: `declarations/events/` (one file per event type, with its `constant` and its `payload` keys, or `null` for a name with no catalogued payload) and `declarations/readings/` (one file per projection, with the event types it reads, whether it is reduced in order, and the types folded on append). `pnpm declarations:update` validates them and assembles, sorted by file name, `scripts/core/events.ts` (the constants and `EVENT_PAYLOADS`) and `scripts/core/projection-types.ts` (`PROJECTION_TYPES`, `REDUCED_IN_ORDER` and the types folded on append, which `scripts/core/bus-readings.ts` reads); both are generated rows rebuilt on update, so two cards that each add an event file no longer overlap on the catalog. A new event is one new file.

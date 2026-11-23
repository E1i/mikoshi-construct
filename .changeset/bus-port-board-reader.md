---
'mikoshi-construct': patch
---

The board reader takes the bus as a contract it is handed. `busReaderAt` in `src/commands/board/bus.ts` returns a reader of a `BoardBus` (`exists`, `readOnly`, the in-order mark, the last-reduced cards and owner waits, the current lane) and no longer imports the bus readings, the card readings or a file opener; `src/commands/board/index.ts`, the board command's root, composes `BOARD_BUS` from them, opening the bus through `withReadOnlyBus` in `src/commands/cost/bus.ts`, the product's one sqlite reader, and hands it in. What the board prints does not change.

The board keeps a read-only port of its own instead of `BUS_CONTRACT` from `scripts/core/bus-adapter.ts`, because that contract is built on `scripts/core/db.ts`, the bus writer, which the product build may not carry; the reader takes the owner wait and bus handle types from their owners through its root.

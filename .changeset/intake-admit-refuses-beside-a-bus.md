---
"mikoshi-construct": minor
---

cli: `construct intake --admit` refuses, with exit `1` and nothing written, when a bus database exists on the machine (`~/.construct/bus.db`, or the file `CONSTRUCT_BUS_DB` names) and the run has no bus wired to write `card.admitted` into it; the refusal names `pnpm intake --admit`. Before, such a run wrote only the journal line, and a reader of the bus never saw the card admitted. On a machine with no bus database the command admits into the journal as before.

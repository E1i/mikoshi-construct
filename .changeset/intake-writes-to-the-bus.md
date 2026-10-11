---
"mikoshi-construct": patch
---

cli: `construct intake`'s confirm, `--admit` and `--move` hand `card.admitted` and `card.moved` to an event port when the caller supplies one, and then write nothing to the journal; without a port the CLI writes its journal lines as before

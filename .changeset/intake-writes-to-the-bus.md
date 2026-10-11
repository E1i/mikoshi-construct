---
"mikoshi-construct": patch
---

cli: `construct intake`'s confirm, `--admit` and `--move` hand `card.admitted` and `card.moved` to an event port when the caller supplies one, beside the journal line they write as before, so intake still sees every number it issued and every card it admitted

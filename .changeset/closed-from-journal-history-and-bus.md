---
"mikoshi-construct": minor
---

`construct intake` reads a `depends` or `blocks` as merged from a journal merge line written before `2026-10-12T17:04Z`, or from a card the bus a caller wires in holds `merged` or `closed`; a journal line written after that time counts only through the bus. The published CLI wires no bus, so for it a later merge line no longer removes a `depends`

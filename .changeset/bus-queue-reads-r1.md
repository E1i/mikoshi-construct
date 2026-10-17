---
"mikoshi-construct": patch
---

cli: `construct intake` reads a touch of `scripts/bus/queue.ts` as risk R1, the factory mechanism that decides on merging, so a card that changes it gets decision `owner` and the bus never merges it on its own; the rest of `scripts/bus/` stays R4

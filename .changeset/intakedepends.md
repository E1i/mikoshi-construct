---
"mikoshi-construct": patch
---

`construct intake --draft` now accepts a `depends` or `blocks` on a card the bus holds, such as one in work or in review, just as `--admit` already did. Before, such a card was marked unclear as "neither a parked card, done nor merged" and parked for the window. A reference to a card that is neither parked nor held by the bus still stays unclear.

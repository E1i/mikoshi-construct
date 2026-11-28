---
'mikoshi-construct': patch
---

Board UI v8. The bus builds only what the events since the last build changed: with no new event it writes only `board-stamp.js`, the time and one hash per section; when the new events name cards, or name neither a card nor a PR, it rebuilds only the named cards' details and dialogs; when an event names a PR but no card, more than 500 events arrived, or a minute has passed, it builds the whole board. Every header, panel and card dialog has its own `board-section-<name>.js`, rewritten only when its content changed and removed when its section leaves the board, and after the first full load the page fetches the stamp and then only the sections whose hash moved. The SNAPSHOT row, the `snapshot <age>` reading and the bus-down page read the age of `board-stamp.js`, so a quiet board between full builds no longer reads as stale. A hidden tab neither polls nor renders, and fetches once when it is shown or focused again.

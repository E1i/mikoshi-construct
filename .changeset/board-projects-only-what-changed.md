---
'mikoshi-construct': patch
---

Board UI v7. The bus plans each board build from the events that arrived since the last one.
- **No new event:** it builds nothing and writes only `board-stamp.js`, a few hundred bytes carrying the time and one hash per section.
- **New events name cards, or name neither a card nor a PR:** it rebuilds the details and dialogs of only the named cards, reuses the rest, and leaves `board-data.js` as it was. The planned-stall warnings are reused when no event names a card.
- **An event names a PR but no card, more than 500 events arrived, or a minute has passed:** it builds the whole board.

Every header, panel and card dialog has its own `board-section-<name>.js`, rewritten only when its content changed. A section file is removed when its section leaves the board, including any left over from before a restart. After the first full load, the page fetches the stamp and then only the sections whose hash moved. A fresh stamp clears the STALE reading that an older full load raised. A hidden tab neither polls nor renders, and fetches once when it is shown again.

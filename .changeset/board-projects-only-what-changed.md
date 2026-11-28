---
'mikoshi-construct': patch
---

Board UI v7. The bus builds the board only on a tick that follows a new event, and otherwise once a minute so its time readings stay current; on a quiet tick it writes only `board-stamp.js`, a few hundred bytes carrying the time and one hash per section. Every section (each header, panel and card dialog) has its own `board-section-<name>.js`, rewritten only when its content changed and removed when it left the board. After the first full load of `board-data.js`, the page fetches the stamp and then only the sections whose hash moved. A hidden tab neither polls nor renders, and fetches once when it is shown again.

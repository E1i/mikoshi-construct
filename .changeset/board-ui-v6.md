---
'mikoshi-construct': patch
---

Board UI v6. The DAEMONS tile shows only the daemon cards, wrapping to rows, and the installed count; hovering, focusing or tapping a card opens a popover beside it with the daemon's name, its SLEEPING or LOADED chip, its skill description and its mutations, and Escape or moving away closes it. When the bus goes quiet because it is restarting onto a new main, the BUS panel reads `RESTARTING · new main <sha> · <elapsed>` from the last `supervisor.restarted` event instead of FLATLINED; FLATLINED stays for a silence with no restart in the last five minutes. A queued card that is not planned into an open release line now has the stage `queue`: it sits in a collapsed `queue (N)` group of the backlog and no longer counts in the FLOW planned column, which now holds only the open line's queued cards.

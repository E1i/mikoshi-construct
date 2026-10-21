---
"mikoshi-construct": patch
---

cli: `construct board` names the bus's last failure of any kind in its footer: a card that fell, a card that lost its session, or a `card.stopped` with reason `fault`, which reads `card #N stopped on a fault at <ts>`; before, a fault stop was skipped and the footer could name an older failure

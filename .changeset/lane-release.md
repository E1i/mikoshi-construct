---
"mikoshi-construct": patch
---

The bus no longer keeps a card waiting in a lane once every card it was queued behind has merged or been dropped. A card that has not started yet then gets a lane of its own. It goes to a busy lane only when it shares touches with a card already running there, or depends on a card that is still live. Queued cards that wait behind it never pull it back. A card moved with `intake --move` now launches from the lane it was moved to, including a parking lane numbered above the lane count.

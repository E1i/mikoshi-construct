---
"mikoshi-construct": patch
---

A bus-wired `intake --move` into a parking directory now takes the card off the queue: a move into anything other than a launch lane (`lane-*`, `night-*`, or a dated lane with a one-letter suffix such as `2026-10-30-a`) writes `card.dropped`. It used to write `card.moved` and a fresh `card.admitted` instead, so the bus could launch the card and the board showed it as planned. A dated directory with a word suffix, such as `2026-10-30-folded`, counts as parking.

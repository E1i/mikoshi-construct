---
"mikoshi-construct": minor
---

cli: `construct intake --move <card> --to archive|dropped|superseded` is a drop: the bus holds it as `card.dropped`, a transition of the card automaton, instead of `card.moved`, and the printed line names the event the bus holds. A parked card the bus never admitted can now be dropped; a move into any other directory still refuses such a card. A dropped card is no launch candidate and holds neither its lane nor its touches, including a ladder card waiting on its Ghost review.

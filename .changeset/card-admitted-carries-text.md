---
"mikoshi-construct": patch
---

When a caller wires a card-event port into `construct intake`, each `card.admitted` event it hands over now also carries the admitted card's whole `text` and its sha256 as `textSha`. Without a port, which is how the published CLI runs, `construct intake` writes the same parking files and journal lines as before.

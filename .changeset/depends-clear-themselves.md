---
"mikoshi-construct": patch
---

cli: `construct intake --admit` admits a card whose depends are not merged yet, carrying them in its `card.admitted` beside the `card.waiting` that names them, so the bus launches it once the last one merges with no second `--admit`; only a card whose corrections need a person still waits unadmitted. A depends on a card the bus dropped is refused at admission, naming that card, instead of holding the card for ever. A depends on a read-only probe clears on the probe's `card.verified` with a report, since a probe never merges

---
"mikoshi-construct": patch
---

`construct-intake --admit` and `--amend` report ok only once they have read the card's `card.admitted` back from the bus journal, and name its event id on the line after the ok. When the journal holds no event with that card and text, the command refuses with a non-zero exit instead of printing ok.

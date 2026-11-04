---
"mikoshi-construct": patch
---

`construct-intake --amend <#N>` edits an admitted card straight in the bus: `--touches` and `--creates` take `+<path>` or `-<path>`, `--note` appends a line, `--witness <old>=<new>` replaces a witness, `--who` sets `shift` or `window`. The body comes from the bus, the result passes the same checks as `--admit` — a weaker witness still waits for the owner — and is recorded as a new `card.admitted` with source `amend`; `--dry-run` writes nothing. No file is written and no card number is read from a file name.

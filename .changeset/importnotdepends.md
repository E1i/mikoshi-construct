---
"mikoshi-construct": patch
---

`intake` no longer chains the cards of one draft by their imports: a depends between two cards of a draft comes only from the draft. Where one card's file imports a file another card changes, the consumer's body carries an `import:` note naming that card instead of a `corrected: depends` line, and the card is not held for confirmation for it.

---
"mikoshi-construct": patch
---

An intake correction confirmed with `CONSTRUCT_WINDOW_SHARD` set now records `window under shard <id>` in `card.admitted` and prints the same label, instead of saying a person confirmed it. The `--confirm` token gate is unchanged, and the variable is not set for you: a run without it still records a person.

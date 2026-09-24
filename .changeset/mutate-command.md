---
"mikoshi-construct": patch
---

cli: `construct mutate apply --from <file> --id <id>` applies a brief's named wrong implementation with a copy and a record in `.construct/mutations/`, and `construct mutate judge --id <id> --report <file>` restores it byte for byte from the copy and judges the outcome from the Vitest JSON report the runner hands over (`--baseline` records the green run apply requires); the CLI runs no test itself.

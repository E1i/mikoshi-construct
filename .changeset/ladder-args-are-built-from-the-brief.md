---
"mikoshi-construct": minor
---

templates: the `/implement` skill no longer has the agent copy the brief's acceptance, witnesses, invariants and immutable paths into the ladder's args. `node scripts/construct/check-acceptance.mjs build --brief <file>` parses the brief and prints the whole args object, `harness` included, and the skill passes it to the Workflow unchanged; a brief with no acceptance, an item with no witness or a witness holding a backtick is refused with the item and the reason, and nothing is printed on stdout. A label counts only at the start of a line or after the end of a sentence, and the witness is read after the last `— witness:` outside backticks; the check mode (`--agreed` / `--args`) reads briefs through the same parser.

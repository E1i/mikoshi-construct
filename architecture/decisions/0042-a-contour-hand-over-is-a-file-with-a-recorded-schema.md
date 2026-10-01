# 0042 — A contour hand-over is a file with a recorded schema, and its consumer validates it

Status: proposed · 2026-10-01

## Context

[0003](0003-run-ledger-stops-at-l0.md) records that the run ledger is a step in a skill, L0, reconciled by
`construct cost`. The ladder's other hand-overs were retold: a review verdict reached the journal as a line a
person typed, with no digest of the report it judged or of the brief it was judged against, and the ledger row
was read four ways, each reader with its own idea of a valid line. The owner's decision of 2026-09-30 is that a
transition between contours is a file plus a hash and never a retelling.

## Decision

1. **A hand-over is a file whose shape is a schema under `contract/contours/`**, each with a versioned
   `$id`. `ledger-row.schema.json` is the row step 4 of the implement skill appends; `review-verdict.schema.json`
   is the file the review agent writes beside its report, with `$defs.journalLine` for the `event:review` line.
2. **The producer writes the file and the consumer validates it; nothing is retold.** `pnpm ghosts:verdict` is
   the only writer of the `event:review` line: it checks the verdict's shape, the report's sha256 and the brief's
   approved sha256 first, and a refusal writes nothing. The four readers of the ledger row, `construct cost`,
   `ghosts:launch`, `ghosts:watch` and `pnpm board`, go through `parseLedgerLine`.
3. **The schemas are in the surface.** `contract/surface.json` records each `$id` under `contours`, so
   `contract:bump` computes their bump, and `.construct/runs.jsonl` leaves the `outside` list of
   [0030](0030-public-contract.md): that one line is superseded here.
4. **0003 stands.** Writing the row is still L0 and reconciled by `construct cost`. What is added is that every
   reader refuses a malformed row, naming the field.

## Consequences

- `head` of a verdict is checked in form only, and the board does not re-hash the report: it reads the digests
  the checker wrote. A line written by hand before the checker existed is read as it was.
- The validator reads a subset of JSON Schema (`type`, `required`, `properties`, `items`, `enum`, `const`,
  `pattern`, `minLength`, `anyOf`, `allOf`, `if`/`then`/`else`, `not`, and `$ref` to `#` or `$defs`) and throws on
  anything else. A schema keyword outside that subset is refused, not passed.
- The shipped CLI does not load the schema: `construct cost` runs where `contract/contours/` does not exist.
  A test holds the schema and `parseLedgerLine` to one verdict instead.
- The published cost reader now refuses a `run` that is present but not a non-empty string, which it accepted.

## Enforced by

- L3 tests: the validator keyword by keyword, the schema and the reader agreeing row by row, the checker's
  refusals, the board's reading of a checked line, and the docs naming every field.
- `contract:bump` on the `contours` section of the surface.
- L0 for the agent's write of the two review files and for the window's call of the checker; nothing
  observes either.

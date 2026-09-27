# Brief fixtures

Each `<case>.md` is a brief as the implement skill receives it, and `<case>.expected.json` is what
`node scripts/construct/check-acceptance.mjs build --brief <case>.md` must produce for it. The expected sets were
written before the parser existed, from an independent parse checked by reading; they are not regenerated from the
parser's output.

An expected file holds one of two shapes:

- `{ "args": { task, effort, acceptance, witnesses, invariants, immutable } }` — the build exits 0 and each of these six
  fields of the printed args equals the expected value exactly (the `harness` field depends on the repository and is not
  compared).
- `{ "refusal": [<text>, ...] }` — the build exits non-zero, prints nothing on stdout, and stderr contains every listed
  text.

| Case | The trap it holds |
|---|---|
| a | a label word inside prose, a witness holding a semicolon, a parenthesis in a criterion, a parenthesised Mutations label |
| b | the #249 brief: a Mutations label on its own line with its explanation on the next |
| c | the #266 brief: witnesses with semicolons, quotes and escaped quotes |
| d | a tail after Immutable on the same line, before a parenthesised Mutations label (the PR #256 case) |
| e | a semicolon in quotes outside backticks in a criterion: it splits the item, and the fragment with no witness is refused |
| f | the literal text of the witness marker inside a witness command |
| g | a backtick inside a witness: refused with the reason named, never cut |

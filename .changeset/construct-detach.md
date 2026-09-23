---
"mikoshi-construct": minor
---

`construct detach` (alias `jack-out`): the inverse of `attach`

Removes exactly what `.construct/attach.json` lists and nothing else: the recorded files whose bytes
are still what attach wrote, the recorded directories that emptied, the block attach added to
`.git/info/exclude`, and the record. Every read happens before any write. A carrier you committed
with `git add -f` is adopted and stays; a carrier already gone is named; a carrier whose bytes changed
refuses the whole run with nothing removed. A file attach did not write — the ledger
`.construct/runs.jsonl`, a local `.claude/settings.local.json` — is never deleted and is named as left
behind. There is no `--force`.

The tracked set is read from `.git/index` directly, versions 2 and 3, `sha1` and `sha256`; the CLI
still runs no `git`. Four index shapes are refused with their own reason before anything is removed:
version 4, a split index, a sparse index, and an object format that is neither `sha1` nor `sha256`.

Attach's rollback now removes the block it added to `.git/info/exclude` through the same inverse
instead of restoring the file from memory, so a line appended into the file in the meantime survives.

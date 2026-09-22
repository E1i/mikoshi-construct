---
"mikoshi-construct": patch
---

Two open questions: a check that can never be green, and a path that left no evidence

`doctor` exits 1 on this repository for two conditions that are legitimate and permanent —
`tsconfig.base.json` recorded in the manifest's `sync` branch and absent from the tree, and fifteen
baseline files modified since `init`, which is what a repository that edits its own construct files
looks like. Neither will become green, and a third condition — a real one — would arrive in the same
exit code and go unread. A check that can never be green reports as much as one that can never fail.
The question recorded is whether an owner can declare a construct-owned path they do not want, and
files they maintain themselves, so that `doctor` can tell a declared deviation from an unknown one.

The second question comes from the first one's evidence. Measured: the recorded hash `040735e3…` is
byte-identical to `templates/harness/tsconfig.base.json`, and `git log --all --follow` over the path
returns nothing, so git holds no evidence either way about whether the file was ever on disk here.
Stated, not measured: the message of commit `9c00c33` says `--apply` wrote the path and that it was
then deleted; the owner does not recall deleting it. A path `sync --apply` writes that git does not
track leaves no evidence of having existed, so what the run did is recoverable only from prose — and
the two kinds of claim above are why the entry keeps them apart rather than reading the message as a
record of the action.

Both are named and neither is answered. No design, no code, and nothing repaired: the `sync` record is
a record of the past.

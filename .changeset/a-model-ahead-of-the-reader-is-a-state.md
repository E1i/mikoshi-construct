---
"mikoshi-construct": minor
---

A construct.model.json from a later build is a named state, not a schema failure

A model declaring a `modelVersion` this binary does not understand produced a generic parse failure —
the same path as a missing field or a malformed array. It is now reported as what it is, with the
record, the field and both versions, and the command exits `1` without reading or writing anything.
`doctor`, `graph`, `sync` and `init` all inherit it, because all four read the model.

**The state was not built twice.** One already existed for `construct.json` and everything about it
fitted except that the error and its line named that file and that field in their own text. The
carrier now takes the record and the field as values and both readers raise it, so there is one
mechanism rather than two of the same shape. A manifest from a later build reports exactly the text it
reported before.

The check also runs before the unknown-property check, since a model from a later build will usually
carry fields this binary has never seen and the symptom would otherwise be reported instead of the
cause.

**What it closes.** `readModel` returns `null` when the file is absent, and `null` already means *no
model*, which `doctor` explains by saying `construct init` writes one. Had a version-ahead model
collapsed into that reading, `doctor` would have told someone holding a newer model to run `init` —
proposing to overwrite the file it had just failed to read.

Nothing migrates an older model, no fact kind is added, and `MODEL_VERSION` does not move.

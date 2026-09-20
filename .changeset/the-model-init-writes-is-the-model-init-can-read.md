---
"mikoshi-construct": patch
---

The rule that a construct-authored fact survives while an entry the construct does not own still
stands on it, and the rule that a model naming a fact nobody declares does not parse, are the same
invariant read from two sides: `init` cannot produce a model the next `init` cannot read. That was
true and untested. It is now proved through `runInit` itself, for both ways an entry reaches a fact —
a discovery-authored hypothesis, and a claim standing on one fact through its enforcement and another
through its verification — and it is proved against the file on disk rather than against the merge
function, so it still holds if the set of facts stood on is computed differently tomorrow. The
opposite direction is asserted by the same run: a construct-authored fact nobody stands on is still
dropped.

`writeModel` now parses the bytes it is about to commit and refuses to write them if they would not
parse, which turns a retention regression into a failure at the moment it would create the unreadable
record instead of a puzzle on the next run. The one remaining way to reach a model that cannot be read
is by hand, so a dangling `supportedBy` gets an error of its own that names `construct.model.json`,
names the missing fact, and says the model was neither written nor replaced — the safe recovery is
putting the fact back, not deleting the committed record. The existing model is read and validated
before anything is materialized, so that failure leaves the directory exactly as it found it.

When the merge does keep a fact for an entry it does not own, `init` says so, next to the lines that
already report what it carried over.

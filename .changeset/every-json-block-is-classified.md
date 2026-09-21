---
"mikoshi-construct": patch
---

The identifier scan classifies every JSON block in the documentation instead of selecting the ones it
recognises.

Selection caught the set narrowing — rename a table heading and it failed — and was blind to a block
of a new shape never joining the scan at all. Nothing was missing, so nothing could be missed. A
`construct.model.json` example added to the guide would have gone unscanned in silence, and its claim
ids are exactly the identifiers at issue.

Every block is now one of four kinds: a doctor result and a repository model, both scanned; a
manifest and a sync report, both deliberately not, because their keys belong to other vocabularies.
**A block of any other shape fails the test and is named.** Adding one forces a decision rather than
slipping past.

A model block has its claim ids and `checkId`s read while its structural keys — `modelVersion`,
`facts` — are not treated as identifiers, so the second scanned kind needed no allowlist either.

This is the same move as the field classification that admits a `mixed` value and the type that makes
an unclassified field a compile error: name the forbidden state so it can be prohibited, rather than
arranging for it not to arise.

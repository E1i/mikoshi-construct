---
"mikoshi-construct": patch
---

**Three corrections to the documentation, all of the same class.**

The guide claimed a generated repository gets `architecture/decisions/`; it now does, because the
directory ships. A page teaching the enforcement levels counted four of them above a table of five.
And the sentence that four repositories were ones *this tool did not build* was false — all four were
materialized by earlier versions of this same tool, by one author, in a similar style. The section
whose subject is the difference between *verified* and *not observed* now names its own bias first,
in the guide and in the release note.

One more of the same kind, found on a third reading: the note quoted a retry's cost as a measured
figure, where decision 0008 records it as the difference between two different runs — an estimate of
order. It now says so.

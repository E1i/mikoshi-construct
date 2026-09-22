---
"mikoshi-construct": patch
---

Why a marker with no recorded provenance is not backfilled, said where the reader meets the gap

`doctor` now reports markers that carry no recorded provenance, and the obvious next move — compute a
sha over each body and write it down — is the one move that must not be made. A sha asserts that the
body it hashes is what that run wrote. Computing one over a body nobody recorded asserts authorship of
text whose author is exactly what is unknown, turning *never looked* into *checked and matching*: rule
2 in the direction that manufactures support.

`docs/cli.md` says this under the table of readings, so a reader who meets `unrecorded` there finds the
reason rather than an apparent backlog. Provenance is written only by the run that writes the body: a
discovery run records it for the markers it fills, a marker it did not fill keeps the entry it had,
and `unrecorded` stays until a run rewrites that marker.

This repository's own `open-questions` marker carries the question that leaves open, with its shape
stated rather than a design proposed: the step that knows what body it wrote is a hand-written L0 step,
and any command that records provenance after the fact is indistinguishable at the moment it runs from
the laundering above. So an answer cannot be a command the owner runs afterwards — either the write
happens inside the same act that authors the body, or it does not happen.

No behaviour changes and no code changes; the nine markers stay unrecorded.

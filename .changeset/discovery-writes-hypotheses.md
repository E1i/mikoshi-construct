---
"mikoshi-construct": minor
---

templates: discovery writes hypotheses into `construct.model.json`. The protocol gains a step of its
own after the markers — not a reading of them: a marker is prose answering *what is where*, a
hypothesis is a structural record answering *what this is*, standing on the same two fact kinds and no
third, carrying the commit the run read from and whether that tree was clean. Everything it writes is
authored by `discovery`, so the next `init` leaves it alone. An interpretation those two fact kinds
cannot support stays prose in a marker, and one that looks as though it needs a third kind is recorded
as an open question rather than inventing a way of knowing. The step where the run records what it
wrote now names both addressees: provenance goes to `construct.json` and nowhere else, interpretation
to `construct.model.json` and nowhere else.

The step is instructions to an agent, which nothing enforces — L0. What ships proven is that the
template materializes, that its worked example parses against the schema, and that a discovery-written
hypothesis survives a second `init` while the construct's own half is rewritten byte for byte. That
the netrunner actually comes back from the model with something written in it is shown by a live run
on a real repository, and that run has not happened yet.

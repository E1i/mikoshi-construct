---
"mikoshi-construct": minor
---

**The model has a picture you can look at: `construct graph`.** The renderer that draws
`construct.model.json` as a Mermaid flowchart was reachable only from this repository's own scripts;
now every installation has it. The diagram goes to stdout so it pipes into a file or a viewer, and
the states in it are derived on read by the same code `doctor` reports from — the command decides
none of them itself.

Absence stays a reading of its own: a repository with no `construct.model.json` gets a line on
stderr and an empty diagram, a model that parses and names no entry gets a different line, and both
exit `0`, because nothing to draw is not a failure.

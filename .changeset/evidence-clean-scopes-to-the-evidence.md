---
"mikoshi-construct": minor
---

templates: A hypothesis records whether its own evidence was committed, not whether the tree was clean.
`baseClean` becomes `evidenceClean` and speaks only of the files the facts under that hypothesis name.
The first live discovery run on an adopted repository recorded `false` on every hypothesis and could
not have recorded anything else — `init` writes forty-two files into the repository it adopts before
discovery reads a line — so a required field had one reachable value and distinguished nothing. Scoped
to the evidence it answers both ways on that same path: a hypothesis standing on the repository's own
committed files reads `true`, one standing on a file `init` just wrote reads `false`. The discovery
protocol now carries the command that computes it, `git status --porcelain --` over the paths of that
hypothesis's facts, under the same compute-it-never-estimate-it instruction as the sha256 one-liners.
`doctor`'s annotation says the evidence under the hypothesis was not committed when it was read, which
is neither a doubt about the hypothesis nor a refutation of it. The schema is closed, so a model
written with `baseClean` is rejected by name rather than ignored; nothing in the wild carries a
hypothesis yet. The reasoning is in
[architecture/decisions/0018-evidence-clean-scopes-to-the-evidence.md](https://github.com/E1i/mikoshi-construct/blob/main/architecture/decisions/0018-evidence-clean-scopes-to-the-evidence.md).

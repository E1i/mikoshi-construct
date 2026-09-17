---
"mikoshi-construct": minor
---

Two guards against things that pass green.

An acceptance test now asserts what a generated project *is*, not only that it works: `CLAUDE.md` and `AGENTS.md` carry the project name as their heading. Earlier today a change deleted that heading from the template as a side effect of something else, and nothing went red — the acceptance matrix proves a generated project installs and passes its own harness, and says nothing about what its documents contain. Where a product makes no claim there is no violation, which is the rule that protects a repository from being scolded for an unpromised improvement, read from the other side: anything asserted nowhere can be cut in silence. Removing the heading now fails the suite.

And the `/plan` command, here and in the copy that ships, gains one line: a criterion is verified by what the task changes itself, and if satisfying it needs an action outside the task it belongs to that task. Twice in two days a specification, not an implementation, sent work outside its own boundary — once asking a reader for fields no writer produces, once asking a task to record a state only a later manual step creates.

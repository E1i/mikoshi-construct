---
"mikoshi-construct": patch
---

A repository with no `construct.model.json` now reads as one, instead of reading as a repository in
perfect health. Run `doctor` on such a tree before this change and the Enforcement section was empty
with nothing said about why, and the last line read `You are here: no claim stops before the end of
its chain` — a sentence rendered from `youAreHere: null`, which `selectPath` returns both when every
chain is complete and when there are no chains at all. The two collapsed onto the reassuring side,
which is the direction nobody reports as a bug, and after 0.6.0 it is the majority of repositories:
the model is written only by `init` and never by `sync`.

The distinction now lives in the data rather than in the renderer's inference from an empty list.
`youAreHere` is a discriminated union carrying `at`: `no-model` (there is no `construct.model.json`,
so nothing was read and nothing is known about what the repository claims), `no-claim` (it was read
and it names none), `no-stop` (it carries claims and none of their chains stops), and `stop` (the
first chain that stops, under `stop`). Reading `no-model` as `no-claim` is not a wording mistake the
next renderer can make: the shapes are different, and the case that used to be silent has to be
handled to compile. The Enforcement section says which of the first two it is rather than printing an
empty list a reader would take for a clean repository.

None of this is a failure and none of it moves `ok`: **the exit code does not change for this case**
— a repository with no model still exits `0`. Absence of a subject is not obstruction, and by
[rule 2](architecture/epistemic-rules.md) not having looked is not a finding; saying nothing is known
is not saying nothing is enforced. No verdict is reported as `absent`, `doctor` writes no model and
repairs none, and how a repository acquires one stays the open question it was.

`doctor --json` changes shape at one field: `youAreHere` is `{at, stop?}` and is never `null`.

Three fixtures cover the three situations — no model, a model naming no claim, a model whose chains
all hold — and each asserts the **rendered line**, not only the structured value, because the defect
was invisible in the JSON and visible only in the text.

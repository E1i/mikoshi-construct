---
"mikoshi-construct": patch
---

`harnessProblems` was classified `mixed` last release, deliberately and temporarily: half of what it
returned asserted enforcement and half was provenance, and calling it either would have been a
statement known to be false. It now splits along the rule
[architecture/model.md](architecture/model.md) already states — a verdict is knowledge when it can
become false without anything `init` wrote changing, and provenance when it goes false only when
what `init` installed has changed.

The step-coverage entries leave the field. *"quality" does not run lint*, *typecheck*, *test* and
*contracts:check* asked about a `package.json` script that belongs to the repository's owner, who can
rewrite it tomorrow with no construct file touched. They are read off the `harness-steps` claim
instead, which already carried the first three; where a preset materializes an HTTP contract, that
command's `contracts:check` step now stands under the same claim rather than nowhere.

What stays in `harnessProblems` is the record around the command: `package.json` is gone, it has no
script under the name `construct.json` recorded, or a contract path that manifest points at is
absent. The field is `provenance`, and the `mixed` value is deleted rather than left as a member
nothing uses.

**The exit code does change, for one case.** A repository whose harness command stopped running
`lint`, `typecheck` or `test` used to make `doctor` exit non-zero, because that assertion lived in
`harnessProblems` and `ok` consumes that field. It is now an unsupported claim instead, and `ok` no
longer moves for it.

That follows from the correction rather than sitting beside it. `ok` is a provenance answer: it says
whether the construct's own installation is intact and fully inspectable, and it says nothing about
what is claimed of the repository. A step-coverage assertion was never provenance — a `package.json`
belonging to the repository's owner can stop calling the right command with no construct file
touched — so `ok` consuming it was downstream of the misclassification this release fixes.

If you script on the exit code and relied on it catching a harness that had stopped running its
steps, read `checks` for the `harness-steps` claim instead. The report still says so, and says it
more precisely than before: it names the fact that stopped matching.

The scope is now enforced rather than described. `ok` is computed by a function whose argument type
is derived from the classification and contains only the provenance fields, so reading a knowledge
field while computing it does not fail a test — it fails to compile. That replaces a claim about two
points in time, which nothing observing one point can hold, with a claim about where the value comes
from, which is true or false today.

The promise the previous release made is now closed by a test rather than by memory: no field is
classified `mixed`, none carries a family the code does not declare, and none escapes the question.
Gate A covers `harnessProblems` with no edit to the gate's own source — it reads the classification,
which is demonstrated by reclassifying the field in the gate's input and watching the gate speak
about it.

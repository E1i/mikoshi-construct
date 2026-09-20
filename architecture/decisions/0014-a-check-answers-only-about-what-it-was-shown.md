# 0014 — A check answers only about the set it was shown

Status: accepted · 2026-09-20

## Context

Five figures published by this project were wrong, and all five were wrong the same way: plausible,
arrived at by one method, and quoted as though they had come from another. The last of them was
`construct cost` summing the `usage` of every line in an agent's journal, where the journal repeats one
response's usage on each of its content blocks. It had a test. The test passed. Its fixtures wrote
journal lines with no request identifier at all, so the data it judged could not contain the defect it
would have had to catch.

The same week, a `.gitignore` entry of `bench/`, unanchored, removed `scripts/bench` from version
control and from the linter at once. A commit shipped a changeset describing a harness whose source was
not in it, and `pnpm run quality` reported clean over files it had never opened.

These look like two accidents and are one. **A check answers honestly about the set of things it was
shown, and says nothing whatever about what fell out of that set.** A passing gate over a shrinking set
is indistinguishable from a passing gate over a complete one, which is what makes it dangerous: the
signal is identical and the meaning is not. A document whose whole argument is that a claim is worth
what its enforcement is worth carried five claims whose enforcement was looking elsewhere.

## Decision

The class is closed by two mechanisms, and neither closes it alone. A record that claimed one of them
covered it would be this same defect written down.

**Reconciliation of sets, where a thing can vanish from a reader.** Where two readers each hold a view
of the same population, the views are reconciled and a divergence fails. `tests/every-source-has-a-reader.test.ts`
does this for the source tree: no file may be ignored by git and by eslint at once. One-sided
exemptions stay legitimate — `templates/` is tracked and not linted deliberately — because each of them
leaves the other reader on the file. What is forbidden is the file no reader holds.

**Mutation, where a thing is visible and the check is empty anyway.** Reconciliation does nothing for
`cost.test.ts`: the file was tracked, the test ran, it passed, and it proved nothing, because its
fixture was built so the defect could not appear. Only introducing the defect and watching the check go
red establishes that it checks anything. **Every new check in this repository is proven by mutation
before it is trusted**, and the proof is recorded with it.

That rule earned itself immediately. The first version of the reconciliation test above was written
against `git ls-files`, and reintroducing the real `.gitignore` pattern left it green — an
already-committed file reads as tracked whatever the ignore rules say. It was rebuilt on git's ignore
decision and proven instead by writing a source file into a directory both readers skip and requiring
the check to name it. Without the mutation step, this record would have shipped a second empty check as
the remedy for the first.

**Everything the two mechanisms do not reach stays at L1 review, named as such.** There is no third
mechanism here and inventing one would be the failure this record is about.

## Consequences

Checks in this repository cost more to add: a new one is not done when it passes, but when it has been
seen to fail for the right reason. That is the price, and it is the smaller half of the trade.

It also explains what already works. The heading assertion, the enforcement levels and the lore
vocabulary hold today because each was proven by mutation when it was written, not by luck. Had they
been written the way `cost.test.ts` was, they would have been exactly as green and exactly as empty.

A check whose population can shrink silently is now a design defect rather than a matter of care. Where
a reader's view is built by an ignore rule, a glob, a hand-written list or a matrix over entry paths,
either it is reconciled against an independently derived list, or the record says plainly that nothing
mechanical holds it.

## Enforced by

`tests/every-source-has-a-reader.test.ts` (L3) reconciles the source tree against both readers and
carries its own mutation probe. `tests/cost.test.ts` (L3) pins the defect that produced this record.
The mutation rule itself is L1 review: nothing mechanical can tell a check that fails for the right
reason from one that has never been made to fail at all.

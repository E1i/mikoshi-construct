---
"mikoshi-construct": patch
---

A source file that both git and eslint ignore is checked by nothing, and a test now names any that
exists. That is the shape behind the `bench/` pattern which hid `scripts/bench` from version control
and from the linter at once: each reader answered honestly about the set it was shown, and neither
said anything about what had fallen out of it.

The invariant is deliberately weaker than "both readers see every file", because one-sided exemptions
are legitimate and declared — `templates/` is tracked and not linted on purpose, captured payloads are
written and not tracked on purpose. What must never happen is that a source is exempt from both at
once, because then nothing is left holding it.

It is built on git's ignore decision rather than on what git tracks, which matters: `git ls-files`
reports an already-committed file as tracked whatever `.gitignore` says, so a check written against
tracking passes over the very defect it is meant to catch. The first version of this test was written
that way, and reintroducing the real `.gitignore` pattern left it green. It is proven the other way
now — the test writes a source file into a directory both readers skip and requires the check to name
it — and that probe, not the assertion over today's tree, is what says the check works.

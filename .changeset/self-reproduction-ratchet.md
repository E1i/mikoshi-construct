---
"mikoshi-construct": patch
---

Two claims that were made but never checked are now tests. Materialization is deterministic: for every preset and every AI target, two `init` runs into empty directories with fully pinned variables produce identical file lists and identical hashes, so a future template that reaches for a `Date`, an unordered `Set` or an unsorted walk fails the gate instead of shipping. And the claim that this repository runs on its own construct is now a replay compared against the repository root, with every difference declared in `architecture/self-hosting-drift.yaml` with a reason — ten of them, measured, not assumed — failing in both directions so the list cannot rot into decoration.

Deliberately not done: the replay is never compared against the sha256 map in `construct.json`. That manifest was written by 0.1.0; comparing today's templates to it compares two versions and calls the result reproducibility. Decision 0006 freezes what `init` wrote and scopes the freeze to that branch only, since provenance will write the discovery branch later. The boundary is stated in the test itself: what reproduces is materialization; discovery does not, and pretending otherwise would be the defect this work exists to catch.

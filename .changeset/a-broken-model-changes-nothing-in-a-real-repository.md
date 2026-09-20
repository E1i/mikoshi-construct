---
"mikoshi-construct": patch
---

The proof that a malformed model stops `init` before anything is written now runs against a repository
the construct has actually materialized, rather than against an empty directory.

The distinction is the whole point. In a real repository the model becomes malformed *after* the
repository exists, so the invariant is that nothing was **changed** — not merely that nothing was
created. The test now materializes a complete repository, breaks a `supportedBy` reference, snapshots
every path in the tree with its bytes, and requires the tree to be identical after the failing run. The
only path excluded from that snapshot is `construct.model.json`, which the previous step deliberately
edited, and it is asserted separately so nothing is lost.

A content snapshot alone would have proved less than it appears to, because `init` is deliberately
idempotent: re-running it writes byte-identical content, so the comparison would hold whether or not
the materialization step ran. The test therefore deletes a file `init` is known to create before the
failing run and requires it to still be absent afterwards, which can only be true if the run stopped
first. A sibling test deletes the same file with the model intact and shows `init` does bring it back,
so the probe is known to be live rather than a file that was never going to return.

The error assertion now covers the whole safety contract rather than part of it: the file, the missing
fact, that nothing was replaced, and both ways out — putting the fact back, or dropping the reference
that names it. Those two clauses exist so that deleting the committed record never looks like the
remedy, and they are now protected against a later wording change.

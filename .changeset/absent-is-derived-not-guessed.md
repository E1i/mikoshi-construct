---
"mikoshi-construct": patch
---

Release verification says which of three states left the version absent, and derives the third

`mikoshi-construct@0.15.0` was versioned and never reached the registry. Release verification caught
it, which is what it is for. Its message then named two causes — a staged publish awaiting approval,
or a publish that failed while reporting success — and prescribed the repair for the first:
`npm stage approve`, then re-run. The real cause was neither. The release action had found an
unconsumed changeset in `.changeset/` and updated the version pull request instead of publishing, so
there was nothing staged to approve and nothing to re-run. Every fact in the line was true and it
pointed the reader at a repair that does not exist for the state they were in.

**Three states produce the identical 404**, and they take three different repairs: approve the staged
version, read the failed publish's log, or consume the changesets and release again. The message now
names all three and prescribes none of them while the state is undetermined — the reader is told what
tells them apart, not what to do before they know which one they have.

**The third is not one of three guesses, because it is readable.** Which branch the release action
takes is decided by the tree it runs on: unconsumed changesets in `.changeset/` mean it versions
rather than publishes. The verification checks out that tree to read the version it is verifying, so
it reads the directory from the same checkout and states the cause, with the count and the filenames
that carry it. A tree with nothing pending excludes that state instead, and two are named rather than
three.

**Boundary.** The reading is of the tree the verification checked out, and it says so in those terms.
A changeset merged after a successful publish, while the registry is still catching up, would be read
as versioning; the window is the poll's two and a half minutes and the claim stays scoped to what was
seen. Nothing about the exit codes changes: absent is still 1, unreachable still 2, and unreachable
still claims nothing.

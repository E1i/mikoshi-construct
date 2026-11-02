# The window allows a merge past the review round limit

Status: accepted

## Context

The bus caps the review → answer rounds on one pull request. A pull request that reaches the cap gets no more
review and no more answers, and without a pass on its head the bus never makes it a merge candidate. Without a
route of its own, every such pull request waits for the owner to write an allow-merge decision by hand, which
stops the factory on work the gate has already proved.

## Decision

After the review round limit, the coordinating window may ask the bus to record allow-merge for a pull request
(`pnpm bus:request allow-merge --pr <N> --head <full sha> --dry-run <reviewer session>`), on these terms:

- One dry-run review of the pull request after its last push.
- A finding of that dry run in the gate's zone — code that is not tested or not run — is fixed in one push,
  together with its test. Every other finding (wording, a report, a summary, the description, a changeset) is not
  fixed on the pull request; it goes to a note for later work.
- Then the window requests allow-merge on the current head, naming the dry run. The bus records it as an owner
  decision only when the pull request is open, carries a card, is past the round limit, and the dry run is of
  that pull request at that head or one clean update before it.
- Never for a pull request that touches a security invariant, and never for the version pull request: those stay
  the owner's.

The bus reads this record from the repository it runs in. The rule is in force while this file exists and its
status line reads `accepted`; the owner withdraws it by changing that line, or by deleting the file.

## Consequences

- A pull request stopped by the round limit reaches the merge queue without the owner writing a decision, after
  one dry run and at most one fixing push.
- The round counter is not reset, and CI green, base `main`, the version pull request lock and the security
  invariants still hold at the merge.
- A repository that withdraws this record leaves every round-limited pull request to the owner, which is the
  safe failure.

## Enforced by

- L3 tests: the bus refuses an allow-merge request when this record is absent or not `accepted`, before the
  round limit, on another head, or without the dry run of that head.
- L1 review: whether a dry-run finding is in the gate's zone is the window's judgement.

## What would reverse it

An allow-merge recorded under this rule that merged a pull request against the owner's intent, or a recurring
need to merge past the limit that is better met by raising the limit itself.

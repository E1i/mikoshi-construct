# Checklists

Answer these before the change, not after. They apply the principles in
[principles.md](principles.md); the harness proves the result.

Before introducing a new abstraction:

1. What concrete problem does it solve?
2. Is the complexity required by the domain, an NFR, or an external contract?
3. Can the same requirement be satisfied with fewer components?
4. Does the abstraction reduce coupling, or merely move it?

When changing execution flow:

1. Update the composition root and, where the repo keeps one, the composition model.
2. Make sequence, parallelism, routing and fan-out explicit there.
3. Do not hide orchestration inside unrelated domain objects.
4. Regenerate rendered diagrams from the model; never edit a rendered diagram by hand.

Before a substantial architectural change:

1. Identify the affected contracts, domain boundaries, dependencies and composition.
2. Check whether an existing artifact already describes the area; update that source of truth
   before touching dependent implementation when a contract or composition changes.
3. Implement.
4. Validate that the implementation conforms to the contract and the dependency policy.
5. Regenerate generated docs and diagrams from their sources.
6. Delete obsolete abstractions and documentation instead of stacking compatibility layers.
   Never create a second representation of a decision when an existing source of truth can be
   updated.

When adding a dependency:

1. Check the repo's Dependency Policy (or the default in principles.md).
2. Verify the dependency direction.
3. Prefer an existing capability over introducing another dependency.

When making a local change:

1. Identify which boundary should contain the change.
2. Do not leak implementation details across that boundary.
3. If unrelated components must change, reconsider the decomposition.

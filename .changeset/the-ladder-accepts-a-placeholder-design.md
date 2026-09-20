---
"mikoshi-construct": patch
---

Every architect entry this repository's own `/implement` runs recorded is frozen as a fixture, and the
accounting it produces is worse than the one the rejected payloads showed. Nine entries: three
returned a design, four returned nothing, and **two returned a design in which every value is a
placeholder and were recorded as a success**.

Both of those came after three payloads the runtime could not read. The answer that finally passed was
`decision: "test"`, `contractChanges: "test"`, `compositionChanges: "test"`, `constraints: ["a"]`,
`acceptance: ["a"]`, `files: ["a"]`. The schema accepted it because the schema constrains shape and
never content, the run moved on to the Implement phase, and the implementer was handed `Acceptance
criteria: - a` and `Design spec from the architect: test`. Nothing was red. Six of the nine entries
produced no usable design and only four of the six were visible as failures.

The same nine runs settle the question the rejected payloads left open. The three real designs are
10 667, 13 963 and 17 081 bytes; the largest was accepted on the first attempt, with a
2481-character `decision` and 416 backticks among its values, while the smallest payload the runtime
is known to have refused was 3436 bytes. The size of an answer does not separate one that is accepted
from one that is refused, so a remedy that shortens the answer is aimed at something these runs
contradict — and the two placeholder designs are a recorded example of what shortening degenerates
into under retry pressure.

The nine briefs are kept in full. They are real task statements from this repository, of the shape
that produces a long spec, and they are the corpus a measurement of the design step should run
against, which keeps that measurement free of any other project's material.

Freezing them also found a false positive in the privacy guard: a bare hostname mentioned in prose was
matched case-insensitively, so the TypeScript property access `WorkflowRun.run` inside a recorded
design read as a domain on the `.run` TLD. A bare mention must now be lowercase, which is how
hostnames are written; a capitalised host inside a URL or an e-mail address is still reported.

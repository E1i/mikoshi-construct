# Architecture principles

These principles are the construct's core. They are stack-agnostic and apply to every change in this
repository, by humans and by AI agents alike. Repo-specific facts (paths, scripts, boundaries) live in
[CLAUDE.md](../CLAUDE.md) and [AGENTS.md](../AGENTS.md); where the two genuinely conflict, the repo wins.

**CLI detects facts. Agent interprets the system.** The construct baseline was materialized by
`mikoshi-construct`; everything that requires understanding this codebase was, or will be, written by
the agent during discovery (`/construct-discover`) and refined as the project evolves.

## Before writing code

- Read the surrounding structure first — design tokens, utility and layout classes, existing services
  and helpers, the neighbouring files' idiom — and reuse what is already there before writing anything
  new. Most tasks are a call to something that exists, not a new abstraction.
- The smallest correct diff wins. Extend an existing abstraction rather than adding a parallel one;
  prefer deleting to adding.
- Split heavy logic into small single-purpose files rather than letting a file grow past the point
  where its responsibility can be named in one phrase. One concept, one owner, one home.
- **These rules govern new code and the code you touch.** Match a file's surrounding idiom; never
  mass-convert its units, selectors or query style as a side effect of an unrelated change.

## Architecture

«Localize complexity, make it explicit, and don't introduce complexity that the problem does not
require.» The goal is not to eliminate complexity but to keep the necessary complexity explicit,
isolated and manageable — and to treat accidental complexity as a defect.

- **Decompose by responsibility and domain boundaries.** Split a system into meaningful components,
  never by mechanically adding layers, services or abstractions.
- **Isolate change and implementation details.** Components talk through explicit contracts and
  stable interfaces. A change inside one component must not require understanding or editing
  unrelated parts.
- **Keep the architecture simple.** No abstraction, pattern, service or dependency without a
  concrete reason. Prefer the simplest design that meets the requirements and NFRs.
- **Make composition explicit.** Execution flow — sequencing, parallelism, routing, fan-out/fan-in,
  retries and timeouts where they matter, external boundaries — lives in a composition root (an app
  factory, a CLI/cron entry, an extension init), separate from the implementation it wires. A repo's
  `CLAUDE.md` names its composition roots; where none is named, the app's entry/wiring file is the
  root. Orchestration is never hidden inside a domain object. Where a repo keeps composition models
  (small, one per flow, machine-readable), diagrams are rendered views of them, never the source:
  edit the model and regenerate. No single global graph of every implementation detail.
- **One source of truth per concern.** API behaviour → the API contract (OpenAPI or equivalent).
  External or event messages → event contracts. Execution and composition → the composition model.
  Domain behaviour → domain code and its tests. Dependency boundaries → lint rules. NFRs → a
  requirements document only where nothing mechanical can express them. Never duplicate the same
  fact across README, contract, diagram and implementation; when a representation is generated,
  change the source, never the output. Prefer an executable or validated artifact over a descriptive
  one whenever the property can be checked mechanically — a file nobody validates against is just
  another README.
- **API changes start from the contract.** The implementation conforms to it, consumers read the
  types generated from it, and a breaking change is identified explicitly before it ships, never
  discovered afterwards. The contract carries external behaviour only: no internal implementation
  details and no business rules that are not part of what the API promises.
- **Separate concerns by level.** Domain (what the business means and which rules exist),
  Application (how use cases are orchestrated), Infrastructure (how technical capabilities are
  implemented), Contracts (what a boundary promises its consumers), Composition (how components
  are connected and executed), Dependency Policy (which dependencies and directions are allowed).
  These are names for *what a piece of code is*, used to decide where a change belongs — not folders
  to create. Keep the repo's existing organisation (feature folders, role suffixes) and never add a
  layer it does not already have.
- **Default dependency policy** when the repo declares none: apps depend on packages; packages never
  depend on apps; shared/leaf packages depend on no internal package; no cycles; prefer an existing
  capability over another dependency. Higher-level business logic never depends on infrastructure
  implementation details. A declared policy lives in lint configuration so it is enforced, not read.
- **Accidental complexity is a design smell.** When a change needs unrelated components understood,
  crosses a boundary it should not, or touches several layers for a local behaviour change,
  reconsider the decomposition, coupling or abstraction instead of pushing through.

### Checklists

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

1. Check the repo's Dependency Policy (or the default above).
2. Verify the dependency direction.
3. Prefer an existing capability over introducing another dependency.

When making a local change:

1. Identify which boundary should contain the change.
2. Do not leak implementation details across that boundary.
3. If unrelated components must change, reconsider the decomposition.

## Security

Security is a validation dimension of its own, separate from functional correctness, and unit
tests alone do not cover it.

When a vulnerability or unsafe pattern is found:

1. Fix it.
2. Add a regression test when the behaviour is testable.
3. Add or update a static-analysis rule when the issue is a reusable code pattern.
4. Check whether a dependency caused it; update or replace the dependency when it did.
5. Never suppress or ignore a finding without documenting why.

A finding that appears more than once is an architectural problem, not a symptom to fix again:
find the common root cause, move the protection to a shared boundary, add automated enforcement,
and update the architecture or dependency policy if needed. The durable form of a finding is a
named invariant with a named check — lint, a contract-level test, response validation, an
integration test or a scanner — recorded once where reviewers read it. `review` as the only check
is allowed, but it is the weakest and is listed as such.

## Reasoning budget

Reasoning effort is a budget, not a default. Implementation work starts at low effort under explicit
constraints; the harness (the repo's quality gate: lint, types, tests, contract and composition
checks, security rules) proves the result; more effort is spent only when the harness fails
repeatedly or the task is ambiguous.

- **Classify before starting.** *low*: an existing pattern to copy, a contract already defined, no
  architecture change, no new dependency, nothing security-sensitive. *medium*: a new endpoint or
  integration, a change across several modules, a non-trivial refactor. *high*: an architecture or
  domain-boundary change, a contract redesign, a security-model or dependency-policy change,
  ambiguous requirements, or repeated medium failure.
- **Low effort means stronger constraints, not looser ones.** Implement only the requested change,
  follow the neighbouring pattern, add no abstraction and no dependency, touch no unrelated module,
  never delete, skip or weaken a test, ship the test with the logic, run the harness before
  reporting.
- **High effort means design first.** Inspect the boundaries, weigh alternatives, update the
  contract and composition model before the implementation, state the decision.
- **Escalate by evidence**: low → retry low with the failure in hand → medium → high. Ambiguity at
  any rung goes to design, never to a guess. Reserve the ladder for tasks with a statable acceptance
  criterion; one-line edits stay inline.

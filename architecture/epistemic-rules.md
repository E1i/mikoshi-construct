# Epistemic rules

Nine rules about what may be asserted and on what grounds. They apply to the repository this tool
audits and to this repository itself. Decisions in [decisions/](decisions/) cite them by number, so
the numbering is stable: a rule is never renumbered, and a rule that stops applying is struck
through in place rather than removed.

A rule's normative scope is fixed once written. New scope takes a new number; an existing rule may
gain a "see also" reference to it, never additional scope of its own. Stable numbering protects what
a reference points at, and this protects what it means — widening a rule would silently change what
every citation of it already made, in records nobody is going back to reread.

The same holds for any identifier this repository publishes and others cite. Audited 2026-09-21 over
the two that exist: `doctor`'s check ids, and the enforcement levels L0–L4. Each check id has one
home and one scope — five ids, five files, each declaring its own and emitting no other, with `ci`
naming in a `SCOPE` constant what it cannot see rather than quietly covering it. The levels were
spelled out twice in code, in `src/commands/doctor/verdict.ts` and `src/model/schema.ts`, with
nothing tying the copies together; they agreed, but one could have been widened without the other
noticing. `tests/identifier-scope.test.ts` now holds them to each other.

Enforcement levels referenced below (L0 text only, L1 review, L2 local hook, L3 CI, L4 CI blocking
merge) are defined in [decisions/README.md](decisions/README.md).

1. **Claim ≠ enforcement ≠ enforcement strength.** That something is required, that something checks
   it, and how strongly it is checked are three separate facts. A table with one column conflates
   them.
2. **`unknown` ≠ `absent`.** Absence is asserted only with full scope evidence. Not having looked is
   not a finding.
3. **Explicit ≠ implied claim.** A convention nobody wrote down is not a claim the repository makes,
   and cannot be violated.
4. **`wontfix` requires evidence of intent.** Without it, `intent.state = unknown`.
5. **Ground truth ≠ an agent's opinion.** Every finding records the base SHA it was made against and
   the evidence it rests on.
6. **A task ≠ a finding.** An improvement with no prior claim is not a violation of anything.
7. **Confidence does not replace an evidence state.** A number expressing how sure something is says
   nothing about whether the thing is known, and must not be read as though it did.
8. **The presence of a command ≠ the level at which it is enforced.** A script in `package.json`
   with no hook and no CI is L0, not L2.
9. **An output contract is declared once, by the runtime schema.** Describing the same contract
   again in prose does not reinforce it — it breaks it: the agent starts formatting its answer as
   text for a human. See [decision 0005](decisions/0005-one-output-contract-per-agent.md).

# The reasoning budget

Reasoning effort is a budget, not a default. Work starts at the lowest class that can carry it, the
harness proves the result, and more effort is spent only when verification shows the previous rung
was not enough.

## The classes

| Class | When | What it means in practice |
|---|---|---|
| `low` | An existing pattern to copy, a contract already defined, no architecture change, no new dependency, nothing security-sensitive | Implement exactly the requested change, follow the neighbouring file, add no abstraction, run the harness before reporting |
| `medium` | A new endpoint or integration, a change across several modules, a non-trivial refactor | The same constraints, more room to reason about where the change belongs |
| `high` | An architecture or boundary change, a contract redesign, a security-model or dependency-policy change, ambiguous requirements | Design first: inspect the boundaries, weigh alternatives, update the contract and the composition model, state the decision — then implement |

**`high` means the task still needs designing.** It is not a label for what the task touches. If the
design is already settled and written into the brief, say so and drop a rung: an architect re-deriving
a decision that already exists is the most expensive way to produce nothing.

## The ladder

A run is a sequence of rungs. Each rung implements, then a separate agent verifies:

1. **Design** — for a `high` task before the first rung, and again after a blocked or twice-failed
   attempt. Its outcome is recorded as an attempt like any other, so a run cannot claim `high` with
   nothing to show for the step.
2. **Implement** — at the current class, under the constraints above.
3. **Verify** — the repository's harness against the working tree, returning `passed`, the failure
   excerpt, any security finding, the diff stat, whether a contract changed, and whether a test was
   weakened.

A rung that fails hands the failure to the next attempt. Two failures send the task back to design
before the last rung. A `high` run whose design step did not complete **blocks** rather than
continuing undesigned, and a run that continued without a design it was supposed to have reports
`degraded` — with the class that actually executed, not the one it was asked for.

### When the design step returns nothing

It still happens, and only half of why is known. The boundary is what a run actually read from disk,
not which version materialized the repository. Where the agent definitions on disk still carry the
duplicate output contract — `Your final message is data, not prose. Return exactly one JSON object:`
with a fenced example — the failure is explained: that prose restates the runtime schema in a form
that contradicts it and wins over it. Release 0.2.0 removed it from every agent definition, so the
explanation covers a repository materialized before 0.2.0 and never synced. One such tree has been
read: materialized by 0.1.1, its ladder script carrying a local patch whose commit message diagnoses
this contradiction, and a `sync` against it putting all three agent definitions in `update`. The
patch is evidence that the defect was real and independently diagnosed, not a remedy — it drops the
schema from every `agent()` call and parses the text by hand, the side [decision
0005](https://github.com/E1i/mikoshi-construct/blob/main/architecture/decisions/0005-one-output-contract-per-agent.md)
forbids; upstream deleted the prose instead.

The four failures recorded on this repository are **not** explained by it. The prose was removed at
09:59:04Z on 17 September and all four ran after it, so none of them could read a duplicate contract.
Why they failed is still open.

If your repository was materialized before 0.2.0, run `sync` before reading anything into a design
step that returns nothing.

## What a weakened test does

`testsWeakened` is not advisory. A rung whose harness returns it does not count as passed, whatever
the test output says, and the feedback to the next attempt is explicit: restore the test and make the
implementation pass it.

The asymmetry is the point. On a single day in this project's own repository, an implementer deleted
a heading line from a template and every one of 276 tests passed, because nothing had ever asserted
the heading existed. The same evening, another implementer narrowed an assertion added hours earlier
— and the flag came back, the ladder escalated, and the next attempt restored it stricter than before,
within a minute. The only difference was whether an assertion existed.

## What it costs

Measured on this project's own repository with `construct cost`, in billable tokens (input, cache
writes, cache reads and output summed). These figures were corrected on 2026-09-20: the command had
been summing every journal line, and the journal repeats one response's usage on each of its content
blocks, so everything published before was roughly twice its true size. The comparisons are
unaffected — the same bias ran through all of them — and the absolute numbers below are the
deduplicated ones:

- Two `low` tasks: **312k** and **366k**.
- Nine `medium` tasks: between **437k** and **2.83M**.
- Two `high` tasks that returned nothing usable: **7.56M** and **7.06M**.

The class predicts the price poorly. What dominates is each agent's **entry into the repository** — a
fresh exploration paid in full before anything is produced, and paid again by every agent that
starts. It scales with the size of the repository, not the size of the task: over one day the same
role cost 1.19M, then 2.05M, then 3.16M, then 3.91M, as `src/` grew beneath it.

Two consequences are built into the ladder. A `low` run pays that entry twice — the implementer and
the verifier — and a `high` run three times, which is the real reason not to reach for `high` by
reflex. And a response rejected by the output schema is **not** re-asked by default: a retry buys
another exploration rather than another answer, at 385k to 1.48M for the exploration against the 57k
to 100k one more attempt inside an entry already paid for costs — five to twenty times, measured by
splitting five architect entries at their first structured-output call.

`construct cost --last` prints the accounting for a run; `construct cost` reconciles the ledger the
skill writes against the runtime's own numbers and shows the drift in both directions.

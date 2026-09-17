# The development cycle

The construct exists so that a repository can be handed to a coding agent without hoping for the
best. The cycle below is what the tool bootstraps; each step produces an artifact the next one reads,
and the only step allowed to declare success is the one that runs your quality gate.

```
  init ──▶ discover ──▶ plan ──▶ implement ──▶ verify ──┐
                         ▲                              │
                         └──────── escalate ────────────┘
                                                        │
                    sync ◀── a new release lands ◀───────┘
```

## 1. `init` — the baseline

`construct init` writes the policy, the harness, the contract and the agent instructions, and records
in `construct.json` exactly what it wrote. Nothing after this step guesses what the baseline was: the
record is read, not inferred.

## 2. `/construct-discover` — the repository describes itself

The CLI never interprets your code. It detects facts — package manager, layout, workspace packages,
which files already exist — and everything requiring judgement is left as a marked block for the
agent:

> product · module map · commands · composition roots · dependency policy · high-effort areas ·
> composition · security invariants · defects vs accepted variance · open questions

Discovery fills them by reading the code, and the manifest records provenance: where each marker
lives, who authored it, and the hash of the tree it was written against. Two runs produce different
prose — discovery is not reproducible and does not claim to be — but the question *was this written
by the construct or by a person* always has an answer.

Run it again when the repository has moved: after a large refactor, a new app in the workspace, or a
boundary you have changed on purpose.

## 3. `/plan <feature>` — tasks with criteria, not a wish list

Planning turns a feature into two to six tasks, each independently verifiable, each with two to four
acceptance criteria a harness run or a test can confirm, and each classified `low`, `medium` or
`high`.

Two rules earn their place here, both learned the hard way:

**A criterion is verified by what the task changes itself.** If satisfying it needs an action outside
the task — a file written by a later step, a command someone runs by hand — it belongs to that task,
not this one. Criteria of the form *after X happens, assert Y* are the usual disguise.

**Contract and composition first.** Tasks are ordered so the contract and the composition model
change before the implementation that conforms to them, and before anything consuming the new
behaviour.

## 4. `/implement <task>` — the ladder

Implementation starts at the lowest reasoning class the task can carry, under stronger constraints
rather than looser ones: implement only what was asked, follow the neighbouring pattern, add no
abstraction and no dependency, never weaken a test, ship the test with the logic.

See [the reasoning budget](/guide/reasoning-budget) for what each class means and what it costs.

## 5. Verify — the step that is allowed to say "done"

The implementer does not mark its own homework. A separate agent runs the repository's harness
against the working tree and returns a structured verdict: did it pass, what failed, did the diff
touch a contract, **and was a test deleted, skipped or narrowed**.

That last flag is the whole reason the step exists. An implementation can be made green by lowering
the assertion instead of raising the code, and that change passes every test by construction. When
the flag comes back true the run does not advance — the next attempt is told to restore the test and
make the implementation pass it.

Escalation is by evidence: a failed rung retries at the same class with the failure in hand, then the
next class up. Ambiguity goes to design, never to a guess.

## 6. `sync` — when a new release lands

New templates do not reach a repository by magic and never by re-running `init`.
[`construct sync`](/guide/upgrading) replays today's templates against the record the manifest cut,
classifies every path, reports, and writes only behind `--apply` — and only the paths it can prove
the construct owns.

## Who does what

| Step | Who runs it | What it may not do |
|---|---|---|
| `init` | You | Overwrite anything you wrote |
| `/construct-discover` | The agent | Invent what it cannot read in the code |
| `/plan` | The agent, reviewed by you | Write a criterion its own task cannot satisfy |
| `/implement` | The agent | Report success on its own verification |
| Verify | A separate agent | Edit the tree it is judging |
| `doctor` | You, or CI | Execute anything from the repository it inspects |
| `sync --apply` | You | Touch a conflict, a removal, or a merged file |

## What the cycle does not promise

It does not promise that an agent will write good code. It promises that a change which passes is a
change your harness accepted, that a weakened test is reported rather than absorbed, and that every
claim the tool makes about your repository is one it can point at evidence for —
[including the ones it refuses to make](/guide/what-it-refuses-to-claim).

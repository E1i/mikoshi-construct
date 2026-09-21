# What it refuses to claim

A tool that reports on your repository is worth what its reports are worth. This one is built around
a single rule — **a claim is worth what its enforcement is worth** — and most of the design is what
follows from taking that seriously.

## Where the verdicts come from

`construct doctor` holds no opinion of its own about enforcement. Every verdict it prints is read out
of `construct.model.json` — a record of what is claimed about your repository and on what grounds —
and a test constructs a verdict whose claim is absent from that record and requires the gate to fail.
It cannot report a finding it cannot trace to something written down.

If there is no model, it says so and reports nothing about claims. That is the common state for a
repository upgraded rather than created by this tool, and it is not a fault: nothing was inspected,
so nothing is asserted, and the command still exits zero.

## Three states, and each is a different kind of silence

| State | Means |
|---|---|
| `held` | Facts are named under it, every one was evaluated, and every one holds |
| `unsupported` | Facts are named, every one was evaluated, and at least one does not hold |
| `unknown` | No fact is named, or a named fact could not be evaluated at all |

Each has a reading it is not, and the three are easy to collapse into each other:

- **`held` is not *proven*.** The facts under a claim are necessary conditions, never sufficient ones.
  A stage can be shown unheld; it cannot be shown held at the strength it claims.
- **`unsupported` is not *not enforced*.** It means a named fact stopped matching — a workflow
  renamed, a script rewritten into an equivalent form. The report names the fact, so you can tell
  which.
- **`unknown` is not *absent*.** "I looked everywhere it could be and it is not there" and "I could
  not look" are different sentences, and only one of them should make anybody change their code.

The last distinction decides the exit code. A repository part of which `doctor` could not read is not
one it calls intact; a repository that simply has nothing to inspect is.

## Five levels of enforcement

| Level | What holds it |
|---|---|
| `L0` | Text. A document says so, and nothing checks |
| `L1` | Review. A human is expected to notice |
| `L2` | A local hook |
| `L3` | CI runs it |
| `L4` | CI runs it **and** the result blocks the merge |

Every level above `L0` presumes a mechanism that **can report a failure**. `L3` and `L4` differ over
whether a failure blocks a merge; `L0` and `L3` differ over whether a failure can be raised at all. A
check that is green whether or not the invariant holds reports nothing and is `L0`, however much
machinery stands behind it — and this project found one of those in its own CI after shipping the
model that exposed it.

`doctor` never claims `L4`. Branch protection and organisation rulesets live in the forge's API, not
in your files, and `doctor` reads files. It is run through `npx` inside repositories nobody has
decided to trust yet, so it executes nothing from the repository it inspects — which also means it
cannot answer *is the harness green on a clean checkout*.

It used to answer that with a verdict permanently set to `unknown`. It no longer does. A blind spot
is now represented by a stated boundary — one line saying what the command does not execute and
therefore does not speak about — rather than by a verdict manufactured to fill the space. An answer
nobody can act on is not a smaller finding than no answer; it is a different and worse thing, because
it looks like one.

## Things it will not say

**That your project still builds after a sync.** `sync --apply` writes the paths it can prove the
construct owns. Whether the result passes is your harness's answer, and the upgrade loop puts that
step between the write and the report for exactly this reason.

**That a level it reports is proven.** `held` beside `L3` says the facts named under that enforcement
hold. Whether the mechanism could actually fail if the invariant were violated is a separate question,
and one this tool does not currently answer. It is recorded as open rather than assumed either way.

**That a file it cannot identify is yours.** When the record does not say which template variant
wrote a construct block and no rendering reproduces the recorded hash, the path is classified
`unknown` rather than `conflict`. *We cannot tell what made this* and *you changed this* are
different facts, and merging them tells an owner they broke something they never touched.

**That a deleted file should come back.** A path you removed reads as `removed` for good. Nothing is
ever deleted by the tool either, and a file the construct never wrote is never adopted. There is no
`--force`.

**That the run ledger is complete.** It is written by a step of a skill — a record nobody is obliged
to keep — so it is `L0` and says so. Its value is that `construct cost` reconciles it against the
runtime and prints the drift in both directions, not that it is exhaustive.

**That discovery is reproducible.** Two runs over the same repository produce different prose. What
reproduces is materialization: two `init` runs with identical pinned variables produce byte-identical
trees, and that is tested. Discovery's contribution is covered by provenance instead.

## Verified, or merely not observed

The distinction the project holds itself to, and the reason the documentation keeps naming its
sources rather than only its conclusions.

**Start with the bias, because the sample has one.** The claims about `sync` in these pages rest on
four repositories, and those four share an author, were materialized by earlier versions of this same
tool — 0.1.0 and 0.1.1 — and were built in a similar style by someone with similar habits. The
independence they provide is narrow and specific: none of them was built with `sync` in mind, because
`sync` did not exist when they were made, and none was modified to make the runs work. That is real,
and it is less than "four repositories the tool did not build", which would have been the comfortable
way to say it and would have been false.

What the four did settle is that all seven classification classes occur outside our own fixtures,
including the two that most resembled cells invented to complete a grid.

**And what they could not settle.** Every one of those four keeps its composition models at the
default path, so a defect that reported a filled discovery section as missing could not appear in any
of them. It took a synthetic repository, built to put the models somewhere else, to make it visible.
Four green trees said *not observed here*, which is a different sentence from *does not happen*.

So the sources answer different questions, and neither is complete. A synthetic case checks what
reality did not happen to contain; reality checks what nobody would have thought to invent. The
documentation says which of its claims rests on which.

## Where the decisions live

Each of these is recorded in
[`architecture/decisions/`](https://github.com/E1i/mikoshi-construct/tree/main/architecture/decisions)
with its context, the decision, its consequences and the level at which it is enforced. The
repository your construct materializes gets the same directory for the same purpose.

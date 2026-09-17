# What it refuses to claim

A tool that reports on your repository is worth what its reports are worth. This one is built around
a single rule — **a claim is worth what its enforcement is worth** — and most of the design is what
follows from taking that seriously.

## Three states, and `unknown` is not `absent`

Every check `construct doctor` runs answers with one of three states:

| State | Means |
|---|---|
| `present` | The evidence was read and it is there |
| `absent` | The evidence was read and it is not there |
| `unknown` | The evidence needed to answer could not be read in full |

`absent` is a claim about your repository. It is never reported without a complete scope of evidence,
because "I looked everywhere it could be and it is not there" and "I could not look" are different
sentences, and only one of them should make anybody change their code.

## Five levels of enforcement

Each check also reports how strongly the thing it found is held:

| Level | What holds it |
|---|---|
| `L0` | Text. A document says so, and nothing checks |
| `L1` | Review. A human is expected to notice |
| `L2` | A local hook |
| `L3` | CI runs it |
| `L4` | CI runs it **and** the result blocks the merge |

`doctor` never claims `L4`. Branch protection and organisation rulesets live in the forge's API, not
in your files, and `doctor` reads files. It is run through `npx` inside repositories nobody has
decided to trust yet, so it executes nothing from the repository it inspects — which also means it
cannot answer *is the harness green on a clean checkout*. That one is always `unknown`, because
proving it means running it.

## Things it will not say

**That your project still builds after a sync.** `sync --apply` writes the paths it can prove the
construct owns. Whether the result passes is your harness's answer, and the upgrade loop puts that
step between the write and the report for exactly this reason.

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

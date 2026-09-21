# 0020 — A construct-authored claim is written only where its evidence holds at birth

Status: accepted · 2026-09-21

## Context

Running `init` against an adopted repository — a single-package frontend repository on pnpm whose
owner had written their own `quality` script — showed the tool writing facts it never evaluated.
`buildModel` grounded the `harness-steps` claim in three `file-contains` facts looking for the
construct's own spelling of the harness steps in `package.json`. That repository spells the same
invocations differently. The facts were false at the moment `buildModel` wrote them, and `doctor`
reported the claim `unsupported` from the first run.

That reading is a finding about what the preset shipped wearing the clothes of a finding about the
repository, which is the defect `hook` was removed for in 0.5.0. Widening the needles is not the fix:
a literal substring cannot tell `pnpm lint` from `pnpm run lint`, and a needle that tried would be
guessing at a script the construct did not write. The needle is the construct's signature on its own
script, and what makes it honest is checking it before the claim is made.

## Decision

**A construct-authored claim is written only when every fact it declares holds on the tree `init` has
just written.** Where the evidence does not hold, the claim is not made, the facts nothing else
stands on are not written either, and `init` names each withheld claim together with the evidence
that failed.

Three boundaries hold this to what it is for.

**Only `unsupported`, never `unknown`.** A fact that could not be read is not evidence of absence
([rule 2](../epistemic-rules.md)). A claim whose evidence is unknown is written, because withholding
it would turn "we could not look" into "it is not so".

**Only at birth.** A claim already recorded in `construct.model.json` is rebuilt and kept whatever
its current state. Without this, a second `init` would erase precisely the drift `doctor` exists to
report: a claim that held when it was written and has since stopped holding must read `unsupported`,
not vanish.

**No exception for security.** The principle admits none, and an exception would break the thing the
gate was built for. "The construct wrote `security.yml` and it runs gitleaks" and "this repository
scans for secrets" are different statements, and the construct can check only the first. A security
claim standing on a workflow the construct did not write would be an assertion about a mechanism it
has never read.

## What this withdraws, measured rather than assumed

Two trees through the real `init`, `node-backend` preset:

| Tree | Claims written |
|---|---|
| Empty directory | `no-committed-secret`, `vulnerable-dependencies-are-visible`, `every-change-passes-the-harness`, `harness-steps`, `a-breaking-api-change-is-named-before-it-ships`, `lint-policy` |
| Adopted repository already carrying its own `ci.yml` and `security.yml` | `a-breaking-api-change-is-named-before-it-ships` |

**Four claims are withheld, not one.** An earlier reading of this change held that `ci` would stay
unconditional and keep reading `held`. That was generalised from a single specimen in which `init`
itself wrote `ci.yml`, and the measurement above retires it: on a tree whose CI the owner wrote,
`held` would be false. What survives is what the construct actually wrote — here the contract
workflow, which that tree did not have.

So the report on an adopted repository is shorter than it was, and shorter than this change was first
described as making it. It is shorter **not because less is checked, but because less of it was
pretending** — the same sentence 0.5.0 was released under, now applying to a larger set.

## What is lost, and who picks it up

Withholding the claim withholds a warning with it. Today `harness-steps` is falsely red on a tree
whose `quality` script the owner wrote; afterwards it is absent, and if that owner drops `typecheck`
from their own script, nothing here notices. The same holds for the security claims.

Since [0024](0024-an-absent-claim-is-derived-not-recorded.md) the absence itself is no longer silent:
`doctor` names the claim it is not carrying and the fact that does not hold. That is a different
statement from the lost warning, and it is worth keeping apart. *This repository does not carry
`harness-steps`, and `package.json` does not carry what it would stand on* is true and actionable;
*you have dropped `typecheck` from your own script* is the warning, and it is still gone. What 0024
removes is the silence about the absence, not the absence of the warning.

That is honest — the construct did not write those files and has no standing to speak about them —
but it is a transfer rather than a reduction. The part that can legitimately speak about the owner's
script is discovery, which reads it. A discovery-authored claim may stand on the owner's `quality`
script, and its facts about that script are proper evidence, because discovery looked. This is
[0015](0015-interpretation-stays-with-the-agent.md)'s line: the CLI records facts and checks them,
the agent interprets. What the preset may no longer assert, discovery may.

## The asymmetry this accepts

A withheld security claim and an absent security practice produce the same output: silence. A
repository with no secret scanning at all, and a repository whose own scanning the construct does not
recognise, are indistinguishable in the report.

This follows from rule 2 and is accepted rather than overlooked. Silence is the honest refusal to
assert. But an empty result never names its cause, and a reader of a short list on an adopted
repository will read it as "no complaints" — which is the second half of the defect this decision
fixes, relocated rather than removed.

## Open question — a reading that says why the set is short

**Closed by [0024](0024-an-absent-claim-is-derived-not-recorded.md), as incorrectly posed.** The
question below asks whether an absence should be recorded. The answer is that **the absence does not
need recording at all**: the set of claims the preset can make is recomputed from `construct.json` on
every read and compared with what the model carries, so a claim that was never made is named without
anything being stored, and stops being named the moment its evidence starts holding.

**The locus named below is also wrong, and is left standing rather than edited away.** It says
`ClaimPlacement`. `ClaimPlacement` is `YOU ARE HERE` — which point on one claim's chain the reading
stops at — and this was never about a point on a chain. It is about the membership of the set: which
claims are in the model and which are not. Naming `ClaimPlacement` sent the question at the one
structure that could not answer it, and the mistake is recorded here because a locus named with
confidence is the part a later reader is least likely to re-derive.

The section as originally written follows.


`init` names each withheld claim once, at adoption, in output nobody keeps. A week later `doctor`
shows a short list and explains nothing.

`doctor` should be able to say why the set is short, and the locus is `ClaimPlacement` — its
`CLAIM_PLACEMENTS` of `stop`, `no-stop`, `no-claim` and `no-model` are the only place it already
speaks about the *shape* of its report rather than about a claim. But it has no means to say it:
**the model keeps no trace of a claim that was not made.** A withheld claim leaves nothing behind,
by construction, because the whole point was not to write it.

So this is not "add a line to `doctor`". It is the question of whether such a trace should be
recorded at all — a record of an absence is a new kind of entry in a model whose schema is closed,
and it would have to justify itself against the reason the claim was withheld in the first place.
Deliberately left open here, with its locus named, rather than settled in passing.

## Consequences

An adopted repository gets a model describing only what the construct wrote into it. A repository
materialized from empty is unchanged: every preset claim holds at birth, which the pinned fixture
asserts.

See also [0024](0024-an-absent-claim-is-derived-not-recorded.md), which reports the claims this
repository does not carry by deriving them rather than by recording them.

`docs/cli.md`'s table of when each verdict appears no longer says "Always" for four rows. The
condition is authorship — the claim appears where the construct wrote the file its facts name —
rather than the file's presence, which would be false again on a tree whose `ci.yml` exists but is
the owner's.

## Enforced by

`tests/model-birth.test.ts` (L3): a tree whose `quality` script the owner wrote carries no
`harness-steps` claim and none of the facts it alone stood on, while a tree the construct
materialized carries it reading `held`; a claim already recorded survives a second `init` and still
reads `unsupported`; a claim whose evidence is unknown rather than unsupported is written; and `init`
names each withheld claim with the evidence that failed.

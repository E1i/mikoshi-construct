# 0018 — A hypothesis records whether its evidence was committed, not whether the tree was clean

Status: accepted · 2026-09-21

## Context

A hypothesis carried `baseClean`: whether the working tree the run read carried no uncommitted
change. The first live discovery run on an adopted repository
([observations.md, 2026-09-21, *Discovery writes hypotheses on a live repository, and the base it
reads is never clean*](../observations.md)) recorded `false` on all six hypotheses and showed it
could not have recorded anything else. `init` writes forty-two files into the repository it adopts,
and the protocol samples cleanliness at step 2, which is inside discovery and therefore after `init`.
On the adoption path the field had exactly one reachable value, so every entry carried a caveat that
was true and distinguished nothing.

This repository has removed a check for that shape before. `red-gate` left `doctor` because it was
always `unknown` for one structural cause — `doctor` executes nothing
([0007](0007-doctor-executes-nothing.md)) — on the principle that an answer nobody can act on looks
like a finding without being one. The question `baseClean` asked is sound; it was asked about the
wrong set.

## Decision

The field becomes `evidenceClean`, and it is the cleanliness of the files named by the facts under
that hypothesis's own `supportedBy` — those files only, not the tree around them. A dirty README does
not undermine a conclusion about `apps/`; an uncommitted `apps/api/src/app.ts` under a conclusion
standing on it does. One boolean per hypothesis still, derived from data the entry already carries,
and on the adoption path it now yields both values: a hypothesis standing on the repository's own
committed files reads `true`, one standing on a file `init` just wrote reads `false`.

**The rename is part of the decision, not cosmetics.** `baseSha` keeps meaning the base commit.
Leaving the neighbour called `baseClean` would make `base` mean two things inside one object, and a
reader meeting them side by side would take the second as a qualifier of the first — *was the tree
clean at this SHA* — which is what it meant before this change. The meaning moved, so the name moved
with it, everywhere and with no alias: nothing in the wild carries a hypothesis yet, which is the
same reason the meaning is being changed now rather than after a release.

**Nothing in the CLI computes it.** It is a claim discovery makes about its own run, and by the time
anyone reads the model the tree has moved on, so no later moment can confirm or refute it — the
nature `authoredBy` already has. The protocol therefore carries the exact command,
`git status --porcelain -- <the paths of that hypothesis's facts>`, under the same *compute it, never
estimate it* instruction as the sha256 one-liners in the recording step.

## Consequences

The three readings [architecture/model.md](../model.md) pins survive with the scope added: the value
is about what the hypothesis was derived from and not the tree the run left behind; it is a claim and
not a measurement, with no check that confirms it; and hypotheses carrying different bases coexist by
design.

`doctor`'s annotation changes with the meaning. `false` now says the evidence under that hypothesis
was not committed when it was read — not that the hypothesis is doubtful, and not a refutation of
what it states — and is held to that by the wording guard the hypothesis register already passes.

A model written before this change no longer parses: the schema is closed, so `baseClean` is rejected
by name rather than ignored.

## Enforced by

L3 — `tests/model-schema.test.ts` rejects a hypothesis carrying `baseClean` and accepts one carrying
`evidenceClean`; `tests/model-vocabulary.test.ts` holds `architecture/model.md` to the property list
in `src/model/schema.ts`; `tests/discovery-protocol.test.ts` asserts the protocol names the
`git status --porcelain` command over the paths of the worked example's own facts;
`tests/doctor-hypotheses.test.ts` holds the new annotation to `READS_AS_A_VERDICT` in both registers.

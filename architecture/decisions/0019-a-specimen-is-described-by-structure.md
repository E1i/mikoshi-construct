# 0019 — A specimen is described by structure, never by address

Status: accepted · 2026-09-21

## Context

The records in this repository are written from runs against real repositories — the author's own and
other people's. [0001](0001-findings-corpus-outside-the-cli.md) kept the findings corpus out of this
package, and one of its reasons was that shipping it here "would pull details of other people's
repositories into a public package by default". But 0001 settled only where the corpus lives. It says
nothing about the records that *do* ship here, and those records are written from the same runs.

An audit of `main` found the gap being used. A specimen was named by npm scope and commit; a second by
owner and repository slug; a third was identified by its problem domain, whose vocabulary survived in
six hypothesis identifiers repeated across four passages, including inside a quoted `doctor` capture.
A pass that removes only the scope leaves that repository identifiable by what it does.

The rule was not new. It was already written down in `observations.md`, as a clause inside one
measurement's entry — "from this measurement onward, a specimen is described by shape and not by
address" — and it stayed there. A rule kept inside an observation governs nothing: it was never
applied to the entries above it in the same file, which are the ones the audit found. That is the
reason it is a decision now rather than a sentence.

## Decision

**A repository used as a specimen is described by its structure alone.**

Structure is what the observation needs in order to mean anything, and none of it identifies the
repository: its layout (single-package, monorepo), its role (frontend, backend, browser library,
service), its package manager, its relation to this tool (adopted, materialized, diverged), and the
concrete artifacts the finding turns on — a `quality` script the owner wrote, a build adapter the
preset did not anticipate.

An address is anything that picks the repository out: its name, npm scope, owner or slug, remote URL,
a commit hash where the hash identifies the repository, and **its problem domain where the domain's
vocabulary identifies the product**. The last of these is the one that survives a careless pass,
because it does not look like an identifier. Domain nouns are replaced by the structural kind the
observation was actually about: a lifecycle modelled as a state machine is the finding; which entity's
lifecycle it was is not.

**Where the address sits inside quoted tool output, there are exactly two honest moves**: drop the
quotation and state the reading structurally, or keep the quotation and mark it as redacted.
Substituting other identifiers inside a block that reads as a capture is forbidden — it makes edited
text look like ground truth, which is [rule 5](../epistemic-rules.md) in its plainest form. The choice
is named in the record that makes it, not left to the reader to infer.

**A frozen fixture is exempt, and is not edited.** A file under `tests/fixtures/` whose whole purpose
is to be the content some past version wrote is a record of what was written then, not a record this
repository is still authoring. Rewriting it would make the repository's own history say something it
did not say, which is the same defect as rewriting a quoted capture. The exemption is categorical.
See also [0021](0021-a-record-of-the-past-is-not-edited.md), which states the class this fixture is
one instance of; the reasoning there governs records that carry no address at all.

It is worth stating what the exemption does *not* rest on, because the plausible mechanical reason is
false and would otherwise be reinvented. For
`tests/fixtures/sync/materialized-by-0.1.0/security-invariants.md.frozen`, the manifest beside it
records a content hash for `architecture/security-invariants.md` that the frozen file's own content
already does not match; `sync` classifies that path as `conflict` before any edit and as `conflict`
after one, and `sync-apply` and `sync-variant` compare marker bodies and tree digests before against
after within a single run rather than against any literal. Nothing mechanical stops the edit. The
exemption rests on what the artifact is.

## Consequences

Records stay citable, and the rule can be broken visibly — in a diff, by a reviewer — which is the
whole reason it lives here rather than in any one contributor's notes.

**The three runs recorded in `observations.md` are not reproducible from this repository, and this
record is what made them so.** Their addresses and commits are not held anywhere this repository can
cite. [0001](0001-findings-corpus-outside-the-cli.md)'s findings corpus is a decision and not a
repository: it names "a separate private repository" without a name or a location, nothing in
`architecture/`, `docs/`, `AGENTS.md` or `CLAUDE.md` points at one, and none exists. The entries here
were the only place those addresses were written down, and this record removed them.

That is a real cost and it is larger than the one 0001 accepted. 0001 moved a corpus that was going to
be written either way; this drops a reference that existed. It is recorded as a cost rather than
softened, because the alternative — a word like "recorded" standing in for a record that does not
exist — is the failure this decision is otherwise about. If the findings corpus is ever built, the
mapping belongs in it and these entries can cite it then. That is a change to make at that point, not
a commitment made here.

**What this record does not do.** Addresses removed from the working tree remain in this repository's
git history and in the bodies of the pull requests that introduced them. The rule governs records
written from now on. Removing them from history would be a separate decision about rewriting published
history, and it is not taken here.

Frozen fixtures keep whatever a past version wrote, including references this rule would otherwise
remove. That is correct and is not a backlog item.

## Enforced by

Review (L1). No mechanical check is proposed, and the reason is structural rather than an omission: a
grep that rejected known scopes, slugs and domain vocabulary would have to record in this repository
the exact strings the rule exists to keep out of it. A denylist here is self-defeating in a way
[0004](0004-domain-allowlist-in-templates.md)'s allowlist is not, because the forbidden set is
open-ended and unknowable in advance — the next specimen's domain vocabulary has not been met yet.
The check that does work is a human reading the diff of any record that describes a run.

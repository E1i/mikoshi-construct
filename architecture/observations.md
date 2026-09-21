# Observations

Decisions are stable; observations accumulate, sharpen and go stale. Keeping them apart is why this
file exists. A decision records what was settled and why, and is amended only when the decision
itself changes. An occurrence of something a decision already describes is recorded here, and the
decision points at this file rather than growing a log inside itself — a record that accumulates
entries eventually gets tidied, and tidying a log into the text of a decision adds scope to it
retroactively, which [epistemic-rules.md](epistemic-rules.md) forbids in its header.

Each entry carries a date, what was observed, and the boundary of what it supports. **An observation
is not a frequency.** Two occurrences of the same failure are two occurrences; the population here is
far too small to carry a rate, and nothing causal is claimed from any of it. The findings corpus
proper lives in a separate private repository
([decision 0001](decisions/0001-findings-corpus-outside-the-cli.md)); this file is what that corpus
can point at.

## 2026-09-21 · `testsWeakened` fired on a second class of change

The ladder's `testsWeakened` guard rejected a change in which tests were deleted **together with the
feature and the modules they covered** — doctor's `hook` and `red-gate` verdicts and their check
files, removed deliberately in v5.1 task 3.

The gate detected the deletion correctly and could not determine whether it was legitimate feature
removal or deletion intended to weaken coverage. A human established legitimacy by matching each
removed test to a removed module or fixture; the surviving `runner.ts` coverage was unchanged, and
the test count rose from 566 to 568.

**Boundary.** Two classes have now been observed: a narrowed assertion inside a live implementation
change, and deletion alongside the code under test. Deletion cases may need human adjudication,
because legitimacy depends on whether the module under test also went. Nothing here says how often
either class occurs.

Related: the open question on enforcement capability in [AGENTS.md](../AGENTS.md).

## 2026-09-21 · The architect returned nothing, again

v5.1 task 3 escalated to `xhigh`. The architect failed structured-output validation five consecutive
times and returned nothing, so no implementer ran from a spec.

This is another occurrence of the failure mode
[decision 0008](decisions/0008-a-retry-buys-a-new-exploration.md) already describes, and it changes
nothing about that decision.

**Boundary.** Recorded as an occurrence only. No frequency and no cause is claimed from it.

## 2026-09-21 · Templates inspected before 0.5.0, nothing found

Before publishing 0.5.0 — the release that removes two `doctor` verdicts, renames a third and moves
two more — `templates/` was searched for anything that would become false the moment a new
repository was materialized from it. A stale page in the docs misleads one reader; a stale template
ships the falsehood into every repository the tool creates, and no later edit to the website
catches up with it.

**Inspected:** every occurrence of `doctor` under `templates/`, and every occurrence of the verdict
identifiers `red-gate`, `hook`, `lint-policy`, `construct-tests`, and of `weakestLink` and
`harnessProblems`.

**Found:** nothing. The three templates that mention `doctor` —
`templates/ai/claude/CLAUDE.md.eta`, its `.existing.eta` variant, and
`templates/ai/shared/_claude/commands/construct-discover.md` — describe it only as checking that the
baseline and the discovery markers are intact, which this release does not change. No template names
a verdict, a level or the shape of the output.

**Boundary.** This was a search for identifiers and for the word `doctor`. It is not evidence that
no template prose is stale for some other reason, and it is a search rather than a mechanism: the
task that ties every identifier named in docs and templates to one that exists in code is deferred
to after the release, and until it lands the next removed verdict will need this search repeating by
hand.

## 2026-09-21 · `doctor` 0.5.0 run against a diverged construct repository

Run against `E1i/yacht-trade` at commit `4112643cfe54466ee9cb59535e50f1e392cb67a6`.

**What the tree is, stated precisely.** It was materialized by `construct init` at 0.1.1 and has
since diverged from the templates on 16 paths. It is a **diverged construct repository, not an
adopted one.** [Decision 0017](decisions/0017-v5-adds-no-new-way-of-knowing.md) asks 5.1 to be
accepted against a repository the construct never materialized, and this tree does not answer that.
**That half of the criterion remains open.**

**What `doctor` 0.5.0 returned, before `sync --apply`:**

    ok: true · checks: [] · youAreHere: { at: "no-model" } · unreadableFiles: []
    harnessProblems: [] · uncollectedTests: [] · missingFiles: []
    modifiedFiles: 19 · provenance: 10 markers, all authorship "unknown"
    versionGap: materializedBy 0.1.1, readBy 0.5.0, pending 9

**After `sync --apply`:** `modifiedFiles` 26, `pending` 0, everything else unchanged.

**What the run was worth.** The seven newly-modified files exposed the baseline defect fixed in
[#71](https://github.com/E1i/mikoshi-construct/pull/71): `doctor` compared every path against the
frozen `init` record and ignored the sync record. No fixture had caught it because no fixture ran
`sync --apply` before `doctor`.

The manifest at that commit shows the defect had a second, quieter half. Its sync record names nine
paths, of which eight also appear in the init record and one —
`architecture/decisions/README.md` — appears **only** in the sync record. The eight were compared
against stale hashes, which is where the false entries came from; the ninth was never examined at
all, so it could have been missing or altered without `doctor` saying anything. The noisy half was
reported and the silent half was not, which is the usual order. Seven of the eight appeared as newly
modified, consistent with one of them having already been among the nineteen; that last step is
arithmetic on the reported counts rather than something this record verified directly.

**Two things this run does not establish.**

- **No adopted repository was inspected.** See above; the criterion is open.
- **`uncollectedTests: []` says nothing about the conditional behaviour.** The construct wrote the
  runner config here, so an empty result means only that no recorded test is uncollected. Staying
  silent where the construct did *not* write the runner config remains unverified outside fixtures —
  more so now, since #71 changed how that function locates the config.

## 2026-09-21 · A local npm cache answered with a version that was no longer current

While confirming that 0.5.0 had published, `npm view mikoshi-construct version` returned `0.4.0`
repeatedly, minutes after the publish step had logged `Successfully published`. The registry was not
stale; a local cache was. `--prefer-online` returned `0.5.0`, and `pnpm release:verify` confirmed the
package was installable.

The shape is the one this project keeps meeting: **an answer that is green, or old, for a different
reason than the one assumed**, and indistinguishable from the real answer without a flag that changes
where it is read from. The same shape as the earlier run whose failure turned out to be `EADDRINUSE`
rather than the defect under test.

**Boundary.** One occurrence. It says nothing about how often the cache is stale, only that the
stale answer is not distinguishable from a current one by reading it.

## 2026-09-21 · `continue-on-error` searched for across the templates, one occurrence

A job carrying `continue-on-error: true` is a check that cannot fail, and one was found shipping in
`templates/base/_github/workflows/security.yml` — the dependency audit. The obvious worry was that
whoever set it once had set it elsewhere.

**Searched:** every occurrence of `continue-on-error` under `templates/` and under `.github/`.

**Found:** exactly one, the dependency audit, in the template and in this repository's mirror of it.
A single deliberate choice rather than a habit that spread.

**Boundary.** A negative result, recorded because an unexamined tree and a clean one look identical
from outside. It covers that one string; a check disabled some other way would not appear in it.

## 2026-09-21 · Runs awaiting approval were read as a branch property, not as our own wake

Of 120 CI runs, 29 sat in `action_required`, every one on `changeset-release/main`. This was reported
as a property of that branch — something about how the version pull request is created.

It was not. The changesets action force-pushes that branch whenever the default branch moves, and a
force-push discards the approval already granted, restarting the runs. The 29 were the wake of
ordinary merges landing while a version pull request was open — **our own merges**, each orphaning
the run before it.

The general form is worth more than the instance: **where two explanations fit the same data equally
well, the one that does not involve the observer is the one chosen by default.** The data had been
measured correctly and attributed to the environment, and the alternative was never considered
because it required noticing our own contribution to it.

## 2026-09-21 · Two adopted repositories inspected, and the first broken chain

0017 asks 5.1 to be accepted against a repository the construct never materialized. Two were used,
both copies so nothing was written to the originals, both adopted by running `init` into them and
then `doctor`.

**Specimen A — a repository built to conventions much like the construct's.** 582 commits, pnpm, its
own `vitest.config.ts`, its own workflows including `ci.yml` and `security.yml`. `init` wrote 19 files
and skipped every existing config. `doctor` then reported `ok: true`, no missing, modified or
unreadable files, and **all five claims held**.

That was not the prediction. It held because the repository already satisfied the preset's claims —
it has gitleaks in a security workflow, a `ci.yml` running the harness command, oasdiff on the API
contract — having been built by the same author to the same standards.

**This is a correction to the criterion, not a caveat on the result.** 0017 asked for a repository
the construct never materialized and silently assumed such a tree would be foreign in its
conventions. Specimen A shows those are different properties: the construct never made it, and five
claims hold anyway — not because the construct is universal, but because the repository was written
by someone who thinks the way it does. What tests generality is **written to other conventions**, not
**not materialized by us**, and the criterion should be read that way from here.

**Specimen B — a repository built to other conventions.** jest rather than vitest, npm rather than
pnpm, its own CI. `init` wrote 40 files. `doctor` reported **two claims `unsupported`**, both standing
on the same fact:

    ci             L3  unsupported  expects … — no longer matching: .github/workflows/ci.yml
    harness-steps  L3  unsupported  expects … — no longer matching: .github/workflows/ci.yml
    You are here: every-change-passes-the-harness — enforcement unsupported:
                  .github/workflows/ci.yml no longer matches

The repository has a `ci.yml`; it does not run `pnpm run quality`, so the fact honestly does not hold.
**This is the first time on any real repository that a chain has stopped in the middle**, and the
first time `YOU ARE HERE` has shown the thing it was written for.

### What this discharges, and what it does not

**0017's 5.1 criterion is met.** Both trees were ones the construct never materialized.

**The `uncollectedTests` conditional is verified, on a third specimen, with its counterfactual.**
Getting there took retracting a wrong conclusion, which is the more useful half of this entry.

On specimen A the list was `[]` and the runner config was indeed absent from the manifest — but the
manifest also recorded **zero** test files, because the harness tests already existed there and were
skipped. Two sufficient causes, one empty list. From that and specimen B I concluded that *no*
adopted repository could exercise the branch. That was a negative universal drawn from two samples,
and it was wrong.

The branch needs a repository that **has** a runner config the construct would otherwise write, so
the construct's is skipped and unrecorded, and **lacks** the harness tests, so those are written and
recorded. Specimen C — vitest with its own config, no `scripts/tests/` — is exactly that: no recorded
runner config, four recorded test files.

There the empty list still had a second cause, because that owner's config declared no literal
`include`. Only after giving it one that excludes the construct's tests did the causes separate:

    with the guard     uncollectedTests: []
    without the guard  four entries, every one of them a statement about a config its owner wrote

That contrast is the evidence. The empty list never was.

**Three times in this one investigation an empty result had two sufficient causes**, and each time
only a constructed counterfactual told them apart. The general form is worth more than the finding:
an empty result never names its cause, so where emptiness is meant to prove something, build the case
in which it would be non-empty.

### First evidence on whether 5.2 needs a picture

0017 makes the static graph conditional on whether a picture answers *where am I and where is the
hole* better than a line does. On the first real case with holes in it, the line answered completely:
two unsupported claims, one underlying fact, and the line names that fact. A diagram would have drawn
two red nodes where the line names one cause — more marks, less insight.

**Boundary, and it decides how this reads.** One specimen, a model of five claims, both holes at the
same stage sharing one fact. So the honest statement is **not** that the graph is unnecessary: it is
that there is no evidence for it and one piece against. The case the graph was proposed for — many
facts with overlapping support, where enumerating in words runs longer than a picture — has not been
seen by anybody yet.

The burden therefore sits with whoever wants to build it, which is the bar 0017 set: a picture must
earn its place on top of a model people already read.

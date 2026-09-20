---
"mikoshi-construct": patch
---

`doctor` no longer dies on a repository it cannot fully read, and no longer reports clean over a tree
it never opened. Put a directory where `construct.json` records a file and the command crashed —
`EISDIR` out of an unguarded `readFileSync` in the baseline verdict — while the model path one field
away already handled the same situation correctly, returning `unevaluable` and reporting `unknown`.
Auditing a repository it does not control is the whole job ([decision 0007](architecture/decisions/0007-doctor-executes-nothing.md)),
so dying on an odd tree is a failure at exactly that job.

Unlike the six changes to `doctor --json` before it, this one is an **addition**: `unreadableFiles:
string[]` joins the provenance family, and a consumer that does not know about it reads the same
result it read before. Nothing is renamed, moved or removed.

A recorded path that exists and cannot be read goes there and nowhere else. It is not `missingFiles`
— it exists — and not `modifiedFiles` — nothing was compared — and calling it either would be a claim
about a file the command never opened, which is the substitution
[rule 2](architecture/epistemic-rules.md) forbids. It makes `ok` false, because a part of the tree
`doctor` could not answer for is not a construct it can call intact.

Catching the error and reporting it ship as one change on purpose. A read wrapped in `try` and left
unreported drops the file out of the inspected set in silence, and a clean report over a tree part of
which was never opened is [decision 0014](architecture/decisions/0014-a-check-answers-only-about-what-it-was-shown.md)
by our own hand — worse than the crash, because a crash is loud. Every read in the doctor path is now
made through one reader that records what it could not open: the baseline hashes, the discovery
markers and the composition models, the runner config behind `uncollectedTests`, and `package.json`
behind the harness verdict, which no longer reports a file it could not read as missing.

One category serves every cause. A directory standing where a file is expected, a permission that is
not there, a broken link, a `package.json` that is not JSON — the reading either succeeded or it did
not, and which of them it was travels in the entry beside the path rather than in a second code path.
A new cause needs no new code.

The defect survived a full suite because fixtures are built by people imagining a well-formed tree,
so the fixtures now carry a hostile one: a directory standing where a recorded file is expected,
asserted both ways — the file is reported unreadable, and it is absent from `missingFiles` and from
`modifiedFiles`.

The line that stops the next one is a lint rule rather than a note: under `src/commands/doctor/**`
nothing may import `readFileSync` or `readdirSync` directly, and `readings.ts` is the single exemption.
A fourth unguarded read cannot be written now, rather than being noticed by somebody eventually. The
block restates the dependency boundary it sits on top of, because in flat config the last matching
block replaces a rule's whole option array — a test asserts both halves, so the guard cannot silently
cost the boundary it was added beside.

**If you script on doctor's exit code, read this line.** No field was renamed and none was removed, so
this change is invisible in a list of field changes — but the meaning of the exit code moved. When
`doctor` could not read part of what it was asked about, the run is no longer reported as successful.

`ok` collapses a three-valued world into one boolean and now collapses toward inspection rather than
toward confidence: it answers whether the inspection completed, not whether everything is held. The
opposite choice puts a quiet false calm into an exit code, which is the worst place for one.

That splits the two origins of `unknown`, which share a name and mean different things here.
Obstruction — asked to read, could not — leaves the inspection incomplete and makes `ok` false.
Absence of a subject — no model at all, or no fact named under a claim — means there was nothing to
inspect and the answer is complete, so `ok` stays true. A repository that simply predates
`construct.model.json` is therefore not reported as broken, which matters because after this release
most adopted repositories will be exactly that.

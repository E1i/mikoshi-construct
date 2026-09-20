---
"mikoshi-construct": patch
---

`doctor` stops assembling its own picture of enforcement and becomes a projection of
`construct.model.json`. Its verdicts now take their level from the claim's `enforcement.level` and
their state from the chain derived on read; nothing in that family is computed from evidence any more.

Five changes to `doctor --json`, listed together because five discoveries in five diffs is worse than
one list:

`red-gate` leaves. It was always `unknown` for one reason — doctor executes nothing — which is a
statement about doctor's own limit rather than a fact about a repository. The report now says that
plainly in one line instead of manufacturing a verdict about it.

`hook` disappears. No preset ships a hook, so reporting its absence announced the lack of something
nobody required: a task rather than a finding, and an implied claim nobody wrote. If a repository has
one, discovery records it with its facts and doctor speaks about it, because then there is a claim.

`construct-tests` becomes `uncollectedTests`, in the provenance family. It asks whether the test files
`construct.json` recorded are still collected by the runner config `init` also wrote — which changes
only when the construct's own files change. It reports nothing where the runner config is not in the
record, because there the construct never wrote that end.

`weakestLink` becomes `youAreHere`, taken from the model's own path selection rather than recomputed.

`harnessProblems` is classified `mixed` and splits next.

`checks` becomes the whole model rather than a selection from it. The mapping of doctor check ids
onto claims lived inside `doctor` and decided what the Enforcement section would show, so a model
carrying four claims rendered one — while `youAreHere` selected across all four and could point at a
claim the section did not contain. A projection that keeps its own whitelist is not a projection. The
list is gone: one verdict per claim, in the model's declaration order, and the two names consumers
already read — `ci` and `lint-policy` — survive as an optional `checkId` on the claim itself, so the
identifier lives once, in the model, and `id` falls back to the claim id everywhere else.

Completeness is now a property with a gate on both sides: the set of rendered claim ids is compared
with the set the model carries, and the test proves it by constructing each direction — a claim the
report withholds and a verdict naming a claim nobody wrote — and watching it go red. Where
`youAreHere` names a claim, that claim is asserted to be among the rendered verdicts, so the two
halves of the output cannot disagree again.

The output is quieter on an adopted repository, and that is the point rather than a side effect.
Today's `hook: absent` and `lint-policy: absent` read as findings about your repository and are
findings about what the preset shipped. That substitution is the thing this tool exists to prevent,
and it had been sitting in its own output.

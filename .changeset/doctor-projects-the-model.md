---
"mikoshi-construct": patch
---

`doctor` stops assembling its own picture of enforcement and becomes a projection of
`construct.model.json`. Its verdicts now take their level from the claim's `enforcement.level` and
their state from the chain derived on read; nothing in that family is computed from evidence any more.

Six changes to `doctor --json`, listed together because six discoveries in six diffs is worse than
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

A verdict that is not `held` now says what it actually knows, and a line that omits it cannot be
built. Renaming `.github/workflows/ci.yml` used to print `unsupported` beside the claim's
`enforcement.mechanism` — a positive assertion, sitting next to the state that denies it, naming no
fact — so a reader concluded the enforcement was gone and went looking for enforcement nobody
removed. `evidence` is now `mechanism`, rendered as what the claim expects, and each verdict carries
what its state knows: `doesNotHold` with the fact paths that no longer match under `unsupported`,
and `reason` — `unevaluable` with the paths that could not be read, or `no-fact-named` — under
`unknown`. `youAreHere` carries the same facts, from the same derivation rather than a second one.

The three states stay three. `unknown` has no failing fact by definition, so it names none and blames
nobody: a fact nobody could read is never reported as one that does not hold, which is the
substitution [rule 2](architecture/epistemic-rules.md) exists to prevent. The renderer carries that
structurally rather than by inspection — the facts are a required argument of the call that renders a
verdict which is not held, typed so a line without them does not compile, the same move as the schema
having no `state` key.

The tests now build the broken repository instead of waiting for one: a fact that does not hold, a
fact that cannot be evaluated (a directory where a file is expected), and a stage with no fact named
at all, each asserted down to the rendered line, with all three re-readings held explicitly — `held`
is not proof, `unsupported` is not enforcement gone, `unknown` is not absence.


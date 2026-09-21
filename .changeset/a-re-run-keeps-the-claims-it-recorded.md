---
"mikoshi-construct": minor
---

A second init reads the record instead of asking the directory, and instead of asking you

Three places where `init` derived an answer from the state of the directory when `construct.json`
already held it. All three are only wrong from the second run onward, which is why the rollout is
what triggers them.

**A second `init` deleted the `lint-policy` claim from `construct.model.json`.** Whether the
repository carries the preset's sample was computed from whether the directory is empty — false on
every re-run — so the model was rebuilt without that claim and `mergeModel` dropped it, silently,
while the sample sources were still on disk and every fact under the claim still held. It is now
answered by whether the construct ever materialized the sample here, which the manifest records and
`sync` already computed the same way; the reading is one function both commands call. Three runs on a
tree materialized from empty now leave `construct.model.json` byte-identical from the second run on,
carrying the same claims the first run wrote.

`doctor` follows the same reading, so the two cannot disagree. Where the construct did materialize the
sample and the owner deleted the claim by hand, `doctor` now reads `every-fact-holds` — a run here
really would record it — instead of promising the opposite.

**A second `init` asked again for what it had already been told.** The preset, the agent target, the
project name and the code-review provider are all recorded, and a re-run now reads them and names
them in the configuration block rather than putting the same four questions. A flag still overrides
any of them. The confirmation before writing stays, because it authorises this run rather than
restating a value. The recorded review model is kept too, instead of falling back to the default.

**`init` against a `manifestVersion` from a later build writes nothing**, which `docs/cli.md` has
asserted all along and nothing held. It is now a test.

# mikoshi-construct

## 0.14.0

### Minor Changes

- [#140](https://github.com/E1i/mikoshi-construct/pull/140) [`f1b1728`](https://github.com/E1i/mikoshi-construct/commit/f1b17286a6670f7acd425afb73dbb6a00dba797b) Thanks [@E1i](https://github.com/E1i)! - The workspace policy is recorded, not derived again on every run
  
  Decision 0026, implemented. `allowedWorkspaceImports` answered two questions at once: which packages
  exist, which is a fact about the tree, and what each may import, which is a decision. A second `init`
  re-derived both, so a leaf recorded as importing nothing came back allowed to import the app, and
  `sync --apply` then wrote that looser policy into `eslint.config.mjs` — a dependency policy loosening
  on a repository nobody edited.
  
  Which packages exist is still derived on every run, so a package added since the last one becomes a
  new key. What each may import is now kept once recorded. A new key is given the preset's default for
  a package of its kind: a package under `apps/` may import every other workspace package, anything
  else may import nothing. The run names the keys it added, what each may import, and that
  `eslint.config.mjs` is not rewritten there so a later `sync --apply` would write the new policy into
  it — the consequence, not only the delta.
  
  **Adopting a monorepo whose packages already import each other will now fail lint until you widen the
  policy deliberately.** The default for a first `init` on a monorepo that already carries packages
  used to be permissive — every package allowed to import every other — because the packages were
  detected rather than created. It is now the same narrow default as everywhere else: `packages/*`
  starts at importing nothing. Widening it is a one-line edit to `eslint.config.mjs`, and from then on
  the record keeps what you chose. The old default blessed whatever the repository already did without
  anyone deciding to, and under this release that unchosen policy would have been recorded and kept.
  
  `construct.json` carries the policy as structure under `policy` and declares `manifestVersion` 5. The
  rendered form is derived from the structure and is never read back to recover it, so a formatting
  function is not the authority on what was decided. The rendered entries are sorted by package
  directory, so the policy no longer depends on the order the packages were enumerated in.

### Patch Changes

- [#142](https://github.com/E1i/mikoshi-construct/pull/142) [`341ff2c`](https://github.com/E1i/mikoshi-construct/commit/341ff2cdd41af28459142f564bbfb04fff907965) Thanks [@E1i](https://github.com/E1i)! - The CLI reference carries the line the picture has carried since 0.11.1
  
  `docs/cli.md` describes the picture's legend and the state on each entry, and stopped before the
  sentence the page prints under that legend — that colour carries the derived state and not the
  enforcement level, so the same green covers an L0 claim nobody is obliged to read and an L3 claim
  that fails the build. Nothing in the reference was false; it was incomplete about the one thing the
  page goes out of its way to say.
  
  The reference now repeats that line rather than restating it, and a test holds both against the same
  constant in `src/model/svg.ts`, so a change to the sentence cannot leave the document behind.

- [#139](https://github.com/E1i/mikoshi-construct/pull/139) [`c4b8c6a`](https://github.com/E1i/mikoshi-construct/commit/c4b8c6a9e83e1a418679921553ff4989946ddd69) Thanks [@E1i](https://github.com/E1i)! - The written count says which of two questions it answers
  
  `init` printed "Written: 4 files" and no next step in the same run. Both were right and they counted
  different things: the count was applied write operations, the next step was derived from the
  operations whose content actually differed from what was on disk. On a second run the merges and
  appends reproduce what is already there, so four operations are applied and nothing changes — and the
  reader was left reconciling two numbers that answer different questions under one word.
  
  The row now names both: `59 files, 59 changed` on a first run, `4 files, 0 changed` on a second, `5
  files, 1 changed` where one file was restored. The count is not removed, because the four operations
  did happen. The changed set is now computed once and read by both the count and the next step, so
  they cannot drift apart again.
  
  The three cases of the closing line are unchanged.

## 0.13.0

### Minor Changes

- [#136](https://github.com/E1i/mikoshi-construct/pull/136) [`d640935`](https://github.com/E1i/mikoshi-construct/commit/d640935fe5e7feee71443e45b4b410e043966465) Thanks [@E1i](https://github.com/E1i)! - A second init reads the record instead of asking the directory, and instead of asking you
  
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

- [#134](https://github.com/E1i/mikoshi-construct/pull/134) [`e2db78c`](https://github.com/E1i/mikoshi-construct/commit/e2db78c7f8d39ac2f84f4d438739e1b31ffaa8a5) Thanks [@E1i](https://github.com/E1i)! - Three output lines stop claiming a case they are only true in
  
  Found by taking a live adopted monorepo through `sync`, `sync --apply`, the harness, `init` and
  `doctor`. The model was written and five claims recorded; the output made it read as though nothing
  had happened.
  
  `doctor` told an adopter that `lint-policy` stood on facts that all hold and that `construct init`
  would record it. It never will. The claim comes with the preset's sample sources, and `init`
  materializes those only into an empty directory — which the tree `doctor` inspects never is, because
  it carries a `construct.json`. The `every-fact-holds` reading now splits: it keeps that name and that
  promise only where a run in this repository really would write the claim, and reads `sources-omitted`
  where it would not, saying so instead. `--json` carries the fourth value under `reading`.
  
  `init` reported how many records it carried over and how many it added *after* the list of paths, so
  a second run read as a full re-materialization until the last line. The count, and the variables this
  run changed, now print before the list. What the run changed is reported before what it looked at.
  
  `init`'s closing line named `pnpm install && pnpm run quality` whatever the run did. It now names
  install and the harness where the run wrote a package manifest, the harness alone where it changed
  other files, and nothing at all where it changed no file — which is what a third `init` on the same
  tree does.
  
  `init` chose the `AGENTS.md` and `CLAUDE.md` form from whether the file exists, when the question is
  which form the construct wrote. By the second run the file always exists, so a second `init` replaced
  the full document it had written itself with the short form meant for a repository that already had
  one — on a real adopted monorepo that silently removed the baseline command list. The form now comes
  from `variants` in `construct.json`, which records it, and `appendBlock` no longer counts the heading
  inside its own block as a document heading it must demote. A second and a third `init` on a tree the
  construct materialized from empty now leave both files exactly as the first run wrote them.

### Patch Changes

- [#138](https://github.com/E1i/mikoshi-construct/pull/138) [`8b977cf`](https://github.com/E1i/mikoshi-construct/commit/8b977cfd5a15b779920233c05aecaf1e99e5c45d) Thanks [@E1i](https://github.com/E1i)! - Decision 0026: which packages exist is derived, what each package may import is recorded
  
  A second `init` on the monorepo preset re-derived `allowedWorkspaceImports` from the packages the
  first run created, recording `'packages/shared': ['@x/api']` where the first run recorded `[]`.
  `eslint.config.mjs` is skipped on a re-run, so the file kept the strict policy and the record no
  longer matched it; `sync` reads that path as `update`, and `sync --apply` closes the gap by writing
  the looser policy into the file. Confirmed by running it.
  
  The variable answers two questions at once. Which packages exist is a fact about the tree. What each
  may import is a decision, and after the first run it is the owner's — re-deriving it is the construct
  overwriting what it does not own, which is the shape 0013 and 0006 already settled for the record.
  
  The record decides: the key set is derived every run, so a package the owner added is picked up; the
  allowances of a key already recorded are never re-derived; a new key gets the default the preset
  applies to a package of its kind, measured as `apps/*` may import every other workspace package and
  anything else may import nothing. Widening and narrowing stop being separate cases because a recorded
  value is not touched.
  
  The decision is recorded; its implementation and test are not, and the record says so and carries L0
  rather than a level it does not have.
  
  The record carries two named constraints rather than leaving them to whoever implements it. A run
  that changes a policy variable names both values **and what the change will do** — naming both
  values has held since 0013, and the defect was read and not understood rather than invisible, so the
  consequence is the requirement and the delta is not. And the recorded allowances are kept by
  recording the structure beside the rendered form, never by parsing the map back out of the rendered
  source, which would make a formatting function the authority on what was decided.

- [#137](https://github.com/E1i/mikoshi-construct/pull/137) [`be73f5d`](https://github.com/E1i/mikoshi-construct/commit/be73f5d7eb6085347952a49723b454fac9a84a90) Thanks [@E1i](https://github.com/E1i)! - An observation: the claim that a second init was fixed, from the day it was made to the day it failed
  
  Decision 0013 measured a second `init` on a 43-path tree, made `construct.json` additive and named
  `variants` among the branches that must survive. `docs/guide/upgrading.md` then concluded "That is
  fixed: the record is additive now." The second clause was true and tested; the first read as *the
  second `init` is fixed*, when what was fixed was its record layer. It shipped in v0.3.0 and stood
  through v0.12.2.
  
  The defect rode in on 0013's own sentence — the branches carry the previous entries, "then the
  entries this run wrote". `AGENTS.md` is written by every run, so the freshly computed variant always
  replaced the carried one, and the record handed the right answer to the caller that computed the
  wrong one. The tests held the record's self-consistency and not its stability: the carry-over
  assertion was guarded by a clause excluding every path the run wrote, and a case named *is
  idempotent* asserted four properties the replacement satisfies. Nothing compared what `init` rendered
  across two runs until this week.
  
  The entry is kept because it is the one claim in this corpus with a complete lifespan: when it was
  made, what it was measured on, the layer that evidence covered, the layer the sentence claimed, when
  it was falsified and by what. It is one claim in one repository and carries no rate.

## 0.12.2

### Patch Changes

- [#132](https://github.com/E1i/mikoshi-construct/pull/132) [`f8f32a7`](https://github.com/E1i/mikoshi-construct/commit/f8f32a738b08689c710568af4d5a2ebca7722d57) Thanks [@E1i](https://github.com/E1i)! - The discovery plan skill was not built, and an open question on interpretation freshness
  
  Written out by hand against this repository's model before any code, the plan came out empty: seven
  hypotheses, twenty-eight facts, all holding, zero items under each of the three decay kinds the skill
  was scoped to name. The emptiness is the result. Had anything decayed, `doctor` would already say so
  through the same projection, so the skill as scoped was a second rendering of what the report already
  carries.
  
  The observation also records the procedure, on its second use in a day: a plan written by hand before
  any code, as a check of necessity rather than a preparation for implementation. It sent one change to
  repairing its inputs and stopped this one from being built.
  
  A new open question sits beside the enforcement-capability one and answers something different:
  whether an interpretation has been reconsidered since the tree under its facts moved. Nothing is
  claimed to be stale — what is unknown is whether a reconsideration is owed. The obstacle is named
  too: answering it means reading what changed since a `baseSha`, which means `git`, and `doctor`
  executes nothing.

## 0.12.1

### Patch Changes

- [#129](https://github.com/E1i/mikoshi-construct/pull/129) [`7fed773`](https://github.com/E1i/mikoshi-construct/commit/7fed773488110ee2f1d8c94b3b33136d98c5994d) Thanks [@E1i](https://github.com/E1i)! - Observation: a command that did not run, read as a measurement that did
  
  Two cases on one machine in one day, under the same broken shim: a scan reported pull request bodies
  clean from a run where the tool was never found, and an `evidenceClean` computation would have
  written `true` for five hypotheses from a `git` that never executed.
  
  Recorded as one shape rather than as two tool problems — a command fails, returns empty, and the
  empty is read as a successful measurement. The entry keeps the part that makes it worth recording:
  the failure was visible only because an unrelated expectation happened to contradict the value, and
  on a clean tree the failed measurement and the correct answer coincide exactly. Catching it was luck.
  
  The requirement it leaves is procedural, not a check for a missing binary: a result is not a
  measurement merely because it has the expected shape; the measurement must also evidence that it was
  performed. Where a hypothesis depends on one that cannot show it ran, no hypothesis is written.

- [#128](https://github.com/E1i/mikoshi-construct/pull/128) [`77f7db8`](https://github.com/E1i/mikoshi-construct/commit/77f7db8d5641670340a7f4f14c601c4079189f01) Thanks [@E1i](https://github.com/E1i)! - Discovery runs on this repository, and the open questions name what holds them
  
  The tool had interpreted a specimen, a corporate site and two adopted trees, and never its own
  repository: the model carried zero hypotheses. Running the materialized protocol here writes seven,
  each `authoredBy: discovery` with a computed `baseSha` and a computed `evidenceClean`, and `doctor`
  now reports hypotheses where it reported none.
  
  Three of the four open questions asserted something false about this repository and nothing could
  re-check them. Decision 0025 states why: a hypothesis stands on facts and is re-derived on every
  read, so it cannot go stale silently; a question stands on nothing and therefore can. Premises that
  fit the two fact kinds are now hypotheses the questions cite by id; the judgment halves stay prose
  and the marker says they age.
  
  The elision in the rendered picture now keeps the tail of a long label. Two facts on one long path
  rendered as the same visible line — the latent property recorded a few hours earlier, arriving on
  the first new data. The demonstration moves with it: the blind spot is now the middle of a line, not
  its end.

- [#131](https://github.com/E1i/mikoshi-construct/pull/131) [`18c435c`](https://github.com/E1i/mikoshi-construct/commit/18c435c92e72dcd00b64e49e21afa766d6834304) Thanks [@E1i](https://github.com/E1i)! - The reading-that-never-happened observation no longer rests on one broken toolchain
  
  The entry recorded two cases under one broken shim, which left it readable as one machine's
  misconfiguration. The same reading arose in that session from a second, unrelated cause — a 403 from
  a proxy on the GitHub API — which has no shim under it at all. Zero matches distinguishes neither
  "the tool was not found" nor "the API refused": two sufficient causes, one empty result, and the
  result names neither.
  
  Recorded as reported by the reviewing session and not verified here. Its weight is that the form does
  not depend on the shim, so the opening no longer offers the shim as the explanation.

## 0.12.0

### Minor Changes

- [#126](https://github.com/E1i/mikoshi-construct/pull/126) [`806dd4a`](https://github.com/E1i/mikoshi-construct/commit/806dd4a971918c2c4e25506b99675acf70cee343) Thanks [@E1i](https://github.com/E1i)! - doctor names the claims this preset can make and this repository does not carry
  
  Since the birth gate, a claim whose evidence does not hold is not written — which left `doctor`
  showing a short list and explaining nothing. It now names each claim the preset can make and the
  model does not carry, with the first fact that does not hold:
  
  ```
  Not claimed here: this preset can make these and this repository does not carry them. They have no
  level, because nothing is enforced by a claim that was never made.
    no-committed-secret — .github/workflows/security.yml does not carry what it would stand on.
  ```
  
  **Nothing about this is stored.** The expected set is rebuilt on every read from the preset and vars
  already in `construct.json`, compared with the model, and evaluated against the tree by the same
  machinery that evaluates the claims the model carries. No new entry, no schema change, no
  `MODEL_VERSION` bump, nothing written by `init`. A trace would state what was true at `init` and go
  stale in silence; a derivation stops being reported the moment it stops being true.
  
  The expected set is what the preset **can** claim, not what one `init` materialized: `node-library`
  ships no sample and therefore cannot make `lint-policy` at all, so its absence is a fact about the
  preset and is never reported. An absent claim carries no level, sits in its own block, and changes no
  exit code. Where the tree carries every claim its preset can make, nothing is printed.
  
  Decision 0024 records it, and closes 0020's open question as incorrectly posed: the answer was not to
  record the absence but that the absence needs no recording.

### Patch Changes

- [#126](https://github.com/E1i/mikoshi-construct/pull/126) [`806dd4a`](https://github.com/E1i/mikoshi-construct/commit/806dd4a971918c2c4e25506b99675acf70cee343) Thanks [@E1i](https://github.com/E1i)! - An absent claim distinguishes evidence that fails from evidence that could not be read
  
  The first cut of the not-carried block tested `evaluation !== 'holds'`, which merged two different
  states — *this is false here* and *we could not look* — and left the choice between them to the
  declaration order of `supportedBy`.
  
  Each absent claim now carries its reading: a fact that does not hold, a fact that could not be read,
  or every fact holding. Where both a failing and an unreadable fact are present the failing one is
  reported, because it is the one a reader can act on, and that preference is stated rather than
  inherited from list order.

## 0.11.1

### Patch Changes

- [#124](https://github.com/E1i/mikoshi-construct/pull/124) [`eeeb89c`](https://github.com/E1i/mikoshi-construct/commit/eeeb89c75f0d74f1ec7a08a5640722825c2b5aad) Thanks [@E1i](https://github.com/E1i)! - The picture stops implying that colour carries enforcement strength
  
  On a default-preset tree an L0 claim nobody is obliged to read and an L3 claim that fails the build
  are the same green — true of this repository's own picture, where `vulnerable-dependencies-are-visible`
  is L0 and `no-committed-secret` is L3. The level is written inside each claim, but colour is read
  first and text second, so the page implied that green means *fine* when it means *the facts named
  under it hold*.
  
  One sentence now renders with the legend, because the legend is what explains the colour: colour
  carries the derived state and not the enforcement level, and each claim's level is written inside it.
  Nothing else on the page moves — no new channel, no new colour, no layout change — and stdout is
  untouched.
  
  Decision 0023 records what this does not do: the picture does not show enforcement strength and is
  not intended to, and the sentence prevents a wrong reading rather than supplying a right one. A
  visual channel of its own for strength was costed and set aside, deferred on the same condition 0023
  already sets for interaction — built when there is a recorded reading of the picture, not before.

## 0.11.0

### Minor Changes

- [#118](https://github.com/E1i/mikoshi-construct/pull/118) [`3ef5abf`](https://github.com/E1i/mikoshi-construct/commit/3ef5abffe53edace3b3b03e36fa8035529590134) Thanks [@E1i](https://github.com/E1i)! - A construct.json from a later build is reported, not silently normalised
  
  `upgradeManifest` read any `manifestVersion` whatever its value: a manifest from a later build was
  treated as one from an earlier build, its unfamiliar branches discarded and `manifestVersion`
  rewritten down. Decision 0009 settled the backward direction and left this one open.
  
  Now a `manifestVersion` above what the binary understands throws a named error carrying both
  numbers, and every command that reads the manifest — `doctor`, `sync`, `init`, and `cost` where the
  environment does not already name the runtime — reports one line naming the version found, the
  version understood, and that a newer CLI is needed. Nothing is read and nothing is written.
  
  **This does not help anyone already running an older binary.** A published 0.1.1 will keep throwing
  on a v4 manifest; nothing here reaches it. The change is prospective: it makes the next shape change
  a reportable state instead of a second stack trace, and decision 0022 says so rather than reading as
  a repair of the crash that prompted it.

- [#122](https://github.com/E1i/mikoshi-construct/pull/122) [`cb8683c`](https://github.com/E1i/mikoshi-construct/commit/cb8683c4ed6393ee81272ddacdc54582dd038b43) Thanks [@E1i](https://github.com/E1i)! - construct graph --out writes a picture you can open
  
  `graph` put Mermaid on stdout, which is the right machine-readable artifact and is not something a
  person can open: it needs a viewer that lives somewhere else. `--out <path>` now also writes one
  self-contained HTML file — inline SVG, inline styles, a few kilobytes, and **nothing fetched when you
  open it**: no CDN, no script, no network from a `file://` URL or anywhere else.
  
  stdout is untouched and stays the default. The Mermaid comes out byte for byte as before, pinned by a
  fixture captured from the renderer as it stood before this change.
  
  The renderer is ours rather than an inlined Mermaid, on numbers taken before any code was written:
  the published package is 0.28 MB and Mermaid's minified bundle alone is 3.4 MB, so inlining it would
  grow the package roughly thirteenfold, weigh every rendered file at 3.4 MB, and make a tool whose
  invariant is that it executes no code it did not ship start shipping 3.4 MB of third-party
  JavaScript. Paying that before any person has read the picture inverts the order decision 0017 sets.
  
  Both outputs are serialized from one structure, so they can differ in layout and cannot differ about
  what is in the picture — a test holds them to each other. Decision 0023 records that, and records
  before the fact what would count as evidence the picture is used: one observable signal, and a plain
  statement that the others cannot be measured by a CLI that emits no telemetry.

- [#116](https://github.com/E1i/mikoshi-construct/pull/116) [`165fd6a`](https://github.com/E1i/mikoshi-construct/commit/165fd6a4491742f3b29ef8dd9eec090d3da45f69) Thanks [@E1i](https://github.com/E1i)! - harness-steps names every step of the quality script the construct writes
  
  The templates have always written `pnpm composition:check` into the `quality` script, and no fact
  named it. The claim said the harness runs lint, typecheck and tests, and stood on three needles — so
  it under-reported the script it was standing on, and a composition check silently dropped from that
  script would not have moved the claim.
  
  A `file-contains` fact for `pnpm composition:check` now sits under the claim, and its statement and
  mechanism name the step alongside the others.
  
  The needles are deliberately not widened to also match `pnpm run …`. A literal substring cannot tell
  one invocation from the other, and one that tried would be guessing at a script the construct did
  not write. The needle is the construct's signature on its own script; decision 0020 is what keeps it
  honest, by checking the facts before the claim is made.
  
  `tests/harness-steps-facts.test.ts` holds the template and the facts to each other in both
  directions: every needle must be a substring of the quality script each preset renders, and every
  step of that script must be named by a needle. The second direction is what the missing fact failed.

- [#115](https://github.com/E1i/mikoshi-construct/pull/115) [`4d74a48`](https://github.com/E1i/mikoshi-construct/commit/4d74a48c425df729be851e6831796075ce9a5ff6) Thanks [@E1i](https://github.com/E1i)! - A construct claim is written only where its evidence holds on the tree init just wrote
  
  `init` used to write facts it never evaluated. On a repository whose owner had written their own
  `quality` script, the `harness-steps` claim was grounded in needles looking for the construct's
  spelling of the harness steps — false at the moment they were written, and reported by `doctor` as
  `unsupported` from the first run. That is a finding about what the preset shipped dressed as a
  finding about the repository, which is the defect `hook` was removed for.
  
  Now a construct-authored claim is made only when every fact it declares holds on the tree, the facts
  nothing else stands on are not written, and `init` names each withheld claim with the evidence that
  failed. A claim already in the record is kept whatever its state, so drift still reads `unsupported`
  instead of disappearing; a claim whose evidence is merely unknown is still written, because not
  having looked is not evidence of absence.
  
  **On an adopted repository this withdraws four claims, not one.** A tree already carrying its own
  `ci.yml` and `security.yml` keeps only the claims standing on files the construct wrote. The report
  is shorter than it was — not because less is checked, but because less of it was pretending, which
  is the sentence 0.5.0 shipped under and now covers a larger set. Decision 0020 records what the
  construct stops asserting, that discovery is what may legitimately claim over the owner's own files,
  and the asymmetry this accepts: a withheld security claim and an absent security practice both read
  as silence.

### Patch Changes

- [#117](https://github.com/E1i/mikoshi-construct/pull/117) [`b1a634a`](https://github.com/E1i/mikoshi-construct/commit/b1a634a30e47fa3050d8d1163a9496745d03581c) Thanks [@E1i](https://github.com/E1i)! - Decision 0021: a record of what a past version said is not edited
  
  0019 exempted a frozen fixture from the rewriting it otherwise requires, and gave the reason: the
  fixture states what a past version wrote. That reason was written as a property of one kind of file,
  and it is not one. A published release note listing an older version's harness steps was left alone
  for the same reason, and that file carries no specimen and no address — so the case cannot be a
  carve-out from a rule about how specimens are described.
  
  0021 states the class. A frozen fixture, a published release note, a dated entry in
  `observations.md`: the test is not the file's location but its tense. If an artifact's job is to
  state what was true then, it is not corrected when that stops being true, and what replaces the
  correction is a new dated record saying what changed.
  
  0019 keeps its fixture paragraph and gains a pointer, with no scope of its own — what may be named
  and what may be rewritten are two axes, and by this repository's own convention new scope takes a
  new number rather than widening an existing entry. The record reopens nothing: it states the rule
  those decisions were already following.

- [#112](https://github.com/E1i/mikoshi-construct/pull/112) [`e39ee77`](https://github.com/E1i/mikoshi-construct/commit/e39ee770c78ad051a735eb5b7e3878f90605a148) Thanks [@E1i](https://github.com/E1i)! - Records describe a specimen by structure, never by address
  
  `architecture/decisions/0019` promotes a rule that had been living as a clause inside one
  observation, where it governed nothing: a repository used as a specimen is described by its layout,
  role, package manager, relation to this tool and the artifacts the finding turns on — never by name,
  npm scope, owner, URL, identifying commit or problem domain. Where the address sits inside quoted tool
  output, the quotation is either dropped for a description or marked redacted, never silently edited.
  
  Nine sites that named specimens by address were corrected and one stale citation to a test that does
  not exist was fixed. Frozen fixtures under `tests/fixtures/` are exempt by the record: they are what a
  past version wrote, not what this repository is still authoring.
  
  The record also states the cost rather than softening it. The three runs those entries describe are no
  longer reproducible: their addresses are not held anywhere this repository can cite, and 0001's
  findings corpus is a decision rather than a repository that exists. Addresses already published remain
  in git history and in pull request bodies; the rule governs records written from now on.

- [#119](https://github.com/E1i/mikoshi-construct/pull/119) [`2899345`](https://github.com/E1i/mikoshi-construct/commit/2899345042e478ae18d5e266587068c36c04d247) Thanks [@E1i](https://github.com/E1i)! - doctor says what writes a construct.model.json
  
  On a repository without one, `doctor` reported the absence three times — in Enforcement, in
  Hypotheses and in `YOU ARE HERE` — and never named the command that creates the file. All three
  readings were correct and together they were a dead end: the sentence that resolves it existed only
  in the 0.5.0 release note, which is not where a person meets this.
  
  The Enforcement section now carries one further line, once, saying the file is written by
  `construct init`, that `init` is additive and overwrites nothing it does not own, and that nothing
  forces you to have one. The three existing readings are unchanged and the sentence is added beside
  them: an absent model is a state to explain, not a fault to repair, and it still does not move the
  exit code.

- [#123](https://github.com/E1i/mikoshi-construct/pull/123) [`56e289f`](https://github.com/E1i/mikoshi-construct/commit/56e289f973ce9df3567c51f35456ac1462b58575) Thanks [@E1i](https://github.com/E1i)! - Edge labels in the rendered picture cannot sit on top of each other
  
  The picture's stage labels were separated only where two edges ran between the same pair of nodes.
  Labels belonging to different claims were not touched, and on this repository's own model they stood
  9 pixels apart in one column — the same illegible overprint the parallel-edge fix was meant to end,
  arriving by a route that fix did not cover.
  
  Label placement now excludes the collision by construction rather than detecting it: an anchor that
  would land within one line height of an already-placed one is pushed clear before it is written, so
  no rendered file can contain the forbidden state.
  
  `tests/edge-labels-do-not-collide.test.ts` holds the property, taking the threshold from the
  renderer's own constant rather than repeating a number, and its own description says what it holds:
  **distance, not readability**. Readability was found by a person opening the file, and a green suite
  here is not a claim that the picture reads well — only that no two labels are closer than a line.

- [#120](https://github.com/E1i/mikoshi-construct/pull/120) [`7114467`](https://github.com/E1i/mikoshi-construct/commit/71144671b1b3e15c7a532b78466c6d0ca6c0d382) Thanks [@E1i](https://github.com/E1i)! - The add population is named, before anything is done about it
  
  A live run against an adopted repository left two construct-written artifacts that do not fit it.
  Neither is a conflict — the construct added them and the owner never touched them — so they read as
  ours and sit there inert or wrong.
  
  `architecture/observations.md` now records what `add` actually tests: a path absent from the tree,
  with no recorded sha, that the template groups produced. There is no notion of applicability in the
  classification at all. The only two conditionalities in the tool are `onlyWhenEmpty` mounts and the
  `omittedGroups` they produce, and both key on the tree being empty rather than on what the tree is.
  
  Every path the four presets produce is partitioned rather than sampled: 87 distinct paths, 37 reached
  only in an empty directory, and the remaining 50 across four kinds. Of the five kinds two are already
  conditional and one cannot misfit, so the population where a misfit can occur is exactly 23 paths
  plus the keys merged into `package.json` — and the observed pair fell one in each of the two.
  
  `tests/add-population.test.ts` checks the partition in both directions, so a new template either
  moves the record or fails the build. No fix ships here: nothing under `templates/`, `src/sync/` or
  `src/materialize/` changes.

- [#113](https://github.com/E1i/mikoshi-construct/pull/113) [`2ce9dcf`](https://github.com/E1i/mikoshi-construct/commit/2ce9dcf229d532c515e1d9ea900ca87214b574c6) Thanks [@E1i](https://github.com/E1i)! - Epistemic rule 10: true when written is not true when merged
  
  A sentence whose truth-maker is changed by the same diff that contains it is false on arrival. The
  rule names where such sentences concentrate — the passages that explain the change, and the
  artifact's own account of itself — and requires both to be reread against the finished diff before
  the change is done.
  
  It caught its own introduction. This file's first line counted the rules; adding rule 10 falsified
  that count, inside rule 10's own diff. Fixed in the same change, which is the rule's first
  application and its acceptance test.
  
  Evidence is two sentences written an hour apart in one afternoon, each inside a passage explaining
  the change it sat in. Two occurrences, one author, one file: a shape, not a rate. No mechanical
  check is proposed — the set of such sentences is given by meaning rather than form.

- [#121](https://github.com/E1i/mikoshi-construct/pull/121) [`c4140ee`](https://github.com/E1i/mikoshi-construct/commit/c4140eef662bd22fed481b16d03c40f5d874cea2) Thanks [@E1i](https://github.com/E1i)! - The upgrading guide knows about the model, and about a manifest it cannot read
  
  `docs/guide/upgrading.md` described a four-step loop that has never written a `construct.model.json`,
  so a repository carried forward from before 0.5.0 followed the page exactly and still had none. The
  page now carries the one upgrade case that needs `init`, why it is safe — the record is additive, and
  a construct claim is written only where its evidence holds, so the run cannot invent enforcement the
  tree does not have — and the fact that `doctor` says all of this itself.
  
  It also warns that the list of claims will be **shorter** than before rather than longer, in 0.5.0's
  own words: shorter not because less is checked, but because less of it was pretending. And it carries
  the one failure upgrading produces on its own, a stale CLI meeting a manifest from a later build,
  which now stops with a named line instead of a stack trace.
  
  Written from a run of the sequence, in order, against a tree materialized by an early 0.1.x release
  and carried forward with no model — structurally that tree and no other. `sync`, `sync --apply`,
  `doctor` before and after, `init`, and the later-manifest case were each run and their output is what
  the page quotes. `pnpm run quality` is the one step in the page not exercised there, because that
  tree has no installed toolchain; it is unchanged from before.
  
  No change to `sync`, `init` or any template.

## 0.10.2

### Patch Changes

- [#110](https://github.com/E1i/mikoshi-construct/pull/110) [`02e15b0`](https://github.com/E1i/mikoshi-construct/commit/02e15b0dea6e86365b19a60719d742a18d87ac5f) Thanks [@E1i](https://github.com/E1i)! - `construct graph` shipped in 0.10.0 and was documented in the CLI reference and the README command
  table, and mentioned zero times in the walkthrough a new user actually reads. Reachable is not
  discoverable — the same gap the release sidebar had. Getting started now ends on the picture, which is
  the payoff of the walkthrough: `init` writes the files, `doctor` reports on them, and the graph shows
  what those reports are read out of.
  
  The example is the real rendering of a repository straight after `init`, not a sketch, and the
  documentation site now renders Mermaid fences as diagrams rather than as source.
  
  It also states the two things somebody meeting the model for the first time would otherwise discover by
  surprise: a repository with no `construct.model.json` draws nothing and says so, and `init` is what
  creates one.
  
  **Why a plugin and not a build-time render, decided rather than defaulted.** `vitepress-plugin-mermaid`
  works outside its declared support — it names `vitepress: ^1.0.0` against this site's `2.0.0-alpha.20`,
  and `mermaid: 10 || 11` against mermaid 12, pinned here to 11. That is a real upgrade risk. The
  alternative, rendering to SVG at build time, removes it and ships no renderer to the client, but
  `@mermaid-js/mermaid-cli` peer-requires puppeteer, which puts a headless browser in every CI run, and
  the SVG becomes a generated artifact needing a writer and a staleness check.
  
  The deciding fact is that `docs:build` runs inside `pnpm run quality`, so a VitePress upgrade that
  breaks the plugin turns the harness red on the pull request that bumps it — the most visible moment
  rather than an unpredictable one. The client cost is lazy: mermaid is code-split across chunks loaded
  only when a diagram of that type renders, so pages without one pay nothing.
  
  **The trigger for revisiting is written down**: if a VitePress upgrade breaks the plugin, or a second
  diagram type pulls in chunks that are not lazy, render to SVG at build time instead. Migrating later
  costs roughly one edit per diagram page, which is why the trigger is recorded now rather than left to
  be rediscovered.

## 0.10.1

### Patch Changes

- [#108](https://github.com/E1i/mikoshi-construct/pull/108) [`e6a214c`](https://github.com/E1i/mikoshi-construct/commit/e6a214ce1824a49e73d7a5d84ea11011d960334f) Thanks [@E1i](https://github.com/E1i)! - The release index asserts that versions run newest first, and the next release is the first with a
  two-digit minor — the point at which a string comparison puts `0.10.0` below `0.9.0`. The ordering was
  already numeric and the index takes its sequence from `CHANGELOG.md` rather than sorting it, so the
  assertion and the data cannot agree on one wrong comparison; both properties are now pinned by tests
  instead of being true by accident, with a mutation to a character comparison failing them.
  
  Checked before the release rather than by it, and of the same family as an assertion that pinned the
  newest version as a literal: code written while every minor was a single digit, correct up to the day
  it is not.
  
  **Predicted, so it is not read as a defect.** `0.10.0` is also the first version whose index anchor
  carries a two-digit minor. The link is built as `#_0-10-0`, by the rule observed in rendered output for
  single-digit minors, and nothing asserts that VitePress slugs the two-digit case the same way —
  deliberately, because reasoning about the slugifier is what `docs:anchors` exists to replace. So the
  first real check of that anchor happens in the version pull request that introduces `0.10.0`. If it
  turns red there, `docs:anchors` is doing its job on the render rather than on an assumption, and the
  fix is the anchor, not the gate.

## 0.10.0

### Minor Changes

- [#106](https://github.com/E1i/mikoshi-construct/pull/106) [`0cc12d0`](https://github.com/E1i/mikoshi-construct/commit/0cc12d08afc499caed37bd8ee16b000a190aeb1f) Thanks [@E1i](https://github.com/E1i)! - **The model has a picture you can look at: `construct graph`.** The renderer that draws
  `construct.model.json` as a Mermaid flowchart was reachable only from this repository's own scripts;
  now every installation has it. The diagram goes to stdout so it pipes into a file or a viewer, and
  the states in it are derived on read by the same code `doctor` reports from — the command decides
  none of them itself.
  
  Absence stays a reading of its own: a repository with no `construct.model.json` gets a line on
  stderr and an empty diagram, a model that parses and names no entry gets a different line, and both
  exit `0`, because nothing to draw is not a failure.

## 0.9.1

### Patch Changes

- [#102](https://github.com/E1i/mikoshi-construct/pull/102) [`1d1a639`](https://github.com/E1i/mikoshi-construct/commit/1d1a63943c481c3b8aea041edec4c0d970c00e08) Thanks [@E1i](https://github.com/E1i)! - The documentation sidebar listed `0.5.0`, `0.4.0` and `0.3.0` under Releases — the three versions that
  happen to have hand-written pages — so a visitor saw `0.5.0` as the highest number in the navigation
  and concluded that was where the project stood, while the index below listed everything through the
  current release. The gate added earlier was not at fault: it required every version to be reachable,
  and every version was. Reachable and prominent are different properties, and only the first had been
  asserted.
  
  The sublist is now computed at config time from the same functions the index renders from, so there is
  no generated artifact that can fall behind and no second writer to enumerate. A version with a
  hand-written page links to that page and stays named however old it gets; a version without one links
  to its own section in the index. `pnpm docs:anchors` checks those section links against the rendered
  HTML, because an anchor that misses still lands on the page and says nothing. It runs inside
  `pnpm run quality` rather than only in the docs deployment, which fires on pushes to the default
  branch and never on a pull request — and whose path filter did not cover the sources that generate the
  anchors.

## 0.9.0

### Minor Changes

- [#95](https://github.com/E1i/mikoshi-construct/pull/95) [`905533b`](https://github.com/E1i/mikoshi-construct/commit/905533b95cd18a504bbd568188219fc5c979ad34) Thanks [@E1i](https://github.com/E1i)! - cli+templates: Every `construct cost` report names the version of the CLI that produced it — before
  the numbers in the text register, as `version` in `--json` — and the `/implement` instructions now
  require every figure in the closing usage line to name what measured it: the Workflow tool's own
  accounting, or `construct cost` at the version that command reports. A whole session of published
  cost figures came from a binary that reported `0.1.1` and, on inspection of the bundle itself,
  predates the response-deduplication fix — while the sources they were quoted against are at `0.8.0`.
  Nothing in any of those numbers said so, and the version the binary reports turned out not to be
  enough on its own to place it. A hypothesis already records what tree it was read from; a cost figure
  recorded nothing, and that asymmetry is what this closes.
  
  No figure changes: the arithmetic is untouched and pinned by a test, and the two counting methods
  that are known to disagree remain unreconciled — while they are, provenance is what lets a reader see
  which of them a number came from.

- [#93](https://github.com/E1i/mikoshi-construct/pull/93) [`c727686`](https://github.com/E1i/mikoshi-construct/commit/c727686f287a6f5d6345a024bf476fda157a03d8) Thanks [@E1i](https://github.com/E1i)! - templates: A hypothesis records whether its own evidence was committed, not whether the tree was clean.
  `baseClean` becomes `evidenceClean` and speaks only of the files the facts under that hypothesis name.
  The first live discovery run on an adopted repository recorded `false` on every hypothesis and could
  not have recorded anything else — `init` writes forty-two files into the repository it adopts before
  discovery reads a line — so a required field had one reachable value and distinguished nothing. Scoped
  to the evidence it answers both ways on that same path: a hypothesis standing on the repository's own
  committed files reads `true`, one standing on a file `init` just wrote reads `false`. The discovery
  protocol now carries the command that computes it, `git status --porcelain --` over the paths of that
  hypothesis's facts, under the same compute-it-never-estimate-it instruction as the sha256 one-liners.
  `doctor`'s annotation says the evidence under the hypothesis was not committed when it was read, which
  is neither a doubt about the hypothesis nor a refutation of it. The schema is closed, so a model
  written with `baseClean` is rejected by name rather than ignored; nothing in the wild carries a
  hypothesis yet. The reasoning is in
  [architecture/decisions/0018-evidence-clean-scopes-to-the-evidence.md](https://github.com/E1i/mikoshi-construct/blob/main/architecture/decisions/0018-evidence-clean-scopes-to-the-evidence.md).

- [#97](https://github.com/E1i/mikoshi-construct/pull/97) [`50f7978`](https://github.com/E1i/mikoshi-construct/commit/50f797816c2e29388a3f0bbd1391733a1ebb7c5b) Thanks [@E1i](https://github.com/E1i)! - cli: `construct.model.json` gets its third projection — a Mermaid picture, rendered through the same
  mechanism that already renders `architecture/composition/*.yaml`. `pnpm model:render` writes the
  graph into `architecture/model.md`, and `pnpm model:check` — wired into `pnpm run quality` — reports
  the committed block as stale when the model moves without it. Claims and hypotheses are nodes, the
  facts under them are nodes, and **a fact several entries stand on is drawn once with one edge from
  each of them**: that fan-in is the shape a list cannot show and the reason the projection exists. A
  claim's edges carry the stage they come from, so its two `supportedBy` lists stay apart.
  
  The renderer holds nothing of its own. Every state in it comes from `deriveModelState`, and the gate
  that guards `doctor` is repeated here: a renderer that decides a state from the model — from how many
  dependents a fact carries, from the level a claim declares — fails the test. A repository with no
  `construct.model.json` renders a sentence saying so rather than an empty diagram, and a model that
  parses and names nothing renders a different one: absence is a third reading, not emptiness.

### Patch Changes

- [#96](https://github.com/E1i/mikoshi-construct/pull/96) [`a9a4674`](https://github.com/E1i/mikoshi-construct/commit/a9a467428adfd994f98ae6a6f13874db52d2ce57) Thanks [@E1i](https://github.com/E1i)! - The documentation site stops at a version that no longer exists. `docs/release-notes/` carried three
  hand-written pages and the `Releases` nav link pointed at 0.5.0, while the changelog had already
  recorded nine more releases — the content existed and was simply never rendered, on the page a reader
  lands on when the tool did not work for them.
  
  A generated index at `docs/release-notes/` now lists every version `CHANGELOG.md` carries, newest
  first, rendered by `pnpm release-notes:render` and committed the way the composition diagrams are. A
  release with a hand-written note — 0.5.0 and its upgrade sequence, which no changeset roll-up would
  produce — is linked rather than repeated, so hand-written notes stay the better thing where a release
  needs one.
  
  The floor is held by two tests rather than by remembering: one fails when the committed index drifts
  from the changelog, the other reads the versions from `CHANGELOG.md` and the wiring from the real
  VitePress config and fails in both directions — a version added to the changelog and wired nowhere,
  and wiring removed for a version that exists.

- [#99](https://github.com/E1i/mikoshi-construct/pull/99) [`fd8c76f`](https://github.com/E1i/mikoshi-construct/commit/fd8c76f5319bbffb8427e931e8e0ca4d2c58eaaf) Thanks [@E1i](https://github.com/E1i)! - templates: The discovery protocol's hypothesis step now tells the run to regenerate a rendered model
  where the repository has one, the way its composition step already says to run `composition:render`.
  Writing `construct.model.json` and leaving the artifact rendered from it behind turns the next harness
  run red for a reason nobody connects to the step that caused it.
  
  Found by sweeping every gate over a generated artifact for all the writers of its source, after a gate
  tested in both directions still shipped a release-blocking defect: both of its mutations had been
  performed by one writer, and a second one — the version bot — wrote the source and called no renderer.

- [#100](https://github.com/E1i/mikoshi-construct/pull/100) [`c103628`](https://github.com/E1i/mikoshi-construct/commit/c103628c801951822b2861822d83a2a0f74d7541) Thanks [@E1i](https://github.com/E1i)! - A test guarding the generated release index asserted `order[0]` was `0.8.0` — the newest version on
  the day it was written. Every release moves that value, so the check failed on the release after it
  shipped, for a reason that had nothing to do with what it was guarding. It now asserts the property it
  meant: the list is in descending version order, with more than one entry and a guard against the
  assertion holding vacuously.
  
  The same defect the repository keeps recording in other forms — a statement true of the present
  standing in for the property — this time inside a test written to enforce a property.

- [#98](https://github.com/E1i/mikoshi-construct/pull/98) [`c407022`](https://github.com/E1i/mikoshi-construct/commit/c40702233312bbacb1f42696dd25c91fb989d839) Thanks [@E1i](https://github.com/E1i)! - The release index is generated from `CHANGELOG.md`, and `changeset version` writes `CHANGELOG.md` —
  so every version pull request bumped the changelog, left the generated page behind, and failed its own
  harness on the gate added to keep that page current. The gate was right and the pipeline was missing a
  step: `version-packages` now runs the renderer after `changeset version`, so the page is regenerated
  by the same step that invalidates it.
  
  A test resolves the version script the release workflow names, follows it through `package.json`, and
  fails when that chain no longer reaches the renderer — the state every release was in until now.

## 0.8.0

### Minor Changes

- [#89](https://github.com/E1i/mikoshi-construct/pull/89) [`dfd6598`](https://github.com/E1i/mikoshi-construct/commit/dfd6598df48eb29cb30bf6cbb3c346a538072e8a) Thanks [@E1i](https://github.com/E1i)! - templates: discovery writes hypotheses into `construct.model.json`. The protocol gains a step of its
  own after the markers — not a reading of them: a marker is prose answering *what is where*, a
  hypothesis is a structural record answering *what this is*, standing on the same two fact kinds and no
  third, carrying the commit the run read from and whether that tree was clean. Everything it writes is
  authored by `discovery`, so the next `init` leaves it alone. An interpretation those two fact kinds
  cannot support stays prose in a marker, and one that looks as though it needs a third kind is recorded
  as an open question rather than inventing a way of knowing. The step where the run records what it
  wrote now names both addressees: provenance goes to `construct.json` and nowhere else, interpretation
  to `construct.model.json` and nowhere else.
  
  The step is instructions to an agent, which nothing enforces — L0. What ships proven is that the
  template materializes, that its worked example parses against the schema, and that a discovery-written
  hypothesis survives a second `init` while the construct's own half is rewritten byte for byte. That
  the netrunner actually comes back from the model with something written in it is shown by a live run
  on a real repository, and that run has not happened yet.

## 0.7.0

### Minor Changes

- [#86](https://github.com/E1i/mikoshi-construct/pull/86) [`cb99c0c`](https://github.com/E1i/mikoshi-construct/commit/cb99c0c25c779ab70a4c463b42f109decb080ba6) Thanks [@E1i](https://github.com/E1i)! - `doctor` reads back what the construct was taken to be. The result gains a knowledge-family
  `hypotheses` field: one entry per hypothesis in `construct.model.json`, carrying its statement, the
  base it was read from, and the state derived from the facts named under it — held, unsupported with
  the paths that no longer match, or unknown. The two ways of being unknown stay apart on the wire and
  in the report: a hypothesis whose facts could not be read says so and names them, and a hypothesis
  with nothing named under it says that instead of reading like a reading that failed. An empty list
  never passes for a repository that was looked at and found standing, and a hypothesis recorded
  against a tree with uncommitted changes is reported as one.
  
  Two defects on the hypothesis path go with it: the derivation kept only the state and dropped the
  reason, and it resolved with no facts in hand, so a fact that stopped holding was named by its id
  instead of the path it points at.
  
  The rule that a reading may not be worded as a verdict now covers hypotheses as well as claims, and
  lives in one place both read from rather than in the test beside one renderer. It matters more here
  than it did for claims: `unsupported` on a claim is a statement about a mechanism, while on a
  hypothesis it is a statement about what the repository is, so the false reading — *you are not that*
  — sounds more confident than the true one, which is only that the ground under the interpretation
  stopped matching. Both registers are held to it at the strings, because a rendered line in a test
  resolves to the plain register whatever theme it asks for.

## 0.6.0

### Minor Changes

- [#85](https://github.com/E1i/mikoshi-construct/pull/85) [`6e56f8a`](https://github.com/E1i/mikoshi-construct/commit/6e56f8aa669033b63c414cef975e9c46b2c5966a) Thanks [@E1i](https://github.com/E1i)! - A hypothesis now records the tree it was read from, not just the commit. Beside `baseSha`,
  `construct.model.json` requires `baseClean`: whether the working tree the run began reading carried
  no uncommitted change, before the run had written anything of its own. A construct that engrams an
  interpretation off a dirty deck should say so on the record, so a SHA in the model can no longer
  stand for bytes the interpretation was never formed from.
  
  Both fields are required and neither constrains the other — a repository with files and no commit is
  `baseSha: null` with `baseClean: false`. `baseClean` is a claim discovery writes about its own run,
  never a measurement anything can confirm later, and hypotheses carrying different bases coexist by
  design: the base is how a fresh interpretation is told from a stale one.

## 0.5.4

### Patch Changes

- [#81](https://github.com/E1i/mikoshi-construct/pull/81) [`5916b79`](https://github.com/E1i/mikoshi-construct/commit/5916b7906afe1b1e20a24fa34945d9b9ba09858c) Thanks [@E1i](https://github.com/E1i)! - The identifier scan classifies every JSON block in the documentation instead of selecting the ones it
  recognises.
  
  Selection caught the set narrowing — rename a table heading and it failed — and was blind to a block
  of a new shape never joining the scan at all. Nothing was missing, so nothing could be missed. A
  `construct.model.json` example added to the guide would have gone unscanned in silence, and its claim
  ids are exactly the identifiers at issue.
  
  Every block is now one of four kinds: a doctor result and a repository model, both scanned; a
  manifest and a sync report, both deliberately not, because their keys belong to other vocabularies.
  **A block of any other shape fails the test and is named.** Adding one forces a decision rather than
  slipping past.
  
  A model block has its claim ids and `checkId`s read while its structural keys — `modelVersion`,
  `facts` — are not treated as identifiers, so the second scanned kind needed no allowlist either.
  
  This is the same move as the field classification that admits a `mixed` value and the type that makes
  an unclassified field a compile error: name the forbidden state so it can be prohibited, rather than
  arranging for it not to arise.

## 0.5.3

### Patch Changes

- [#78](https://github.com/E1i/mikoshi-construct/pull/78) [`62a317b`](https://github.com/E1i/mikoshi-construct/commit/62a317b0a25eba890cb1717dfc7077f21aebd97c) Thanks [@E1i](https://github.com/E1i)! - cli: When `red-gate`, `hook`, `construct-tests` and `weakestLink` left `doctor`, the documentation went
  on naming them and nothing failed; a reader would have found out before the build did.
  
  The code now owns two lists instead of one. **Current** is derived and never written by hand — the
  keys of `DOCTOR_FIELD_FAMILY` plus every claim id and check id the model builder produces. **Retired**
  is the new exported list of identifiers this tool has published and no longer uses. Every identifier
  the docs and templates name must sit in one of them, so a removal can be described freely while a name
  in neither list fails the build. The two are asserted disjoint, which is the list's second and larger
  job: a retired name may never come back meaning something else, or every past mention would
  retroactively start saying something false.
  
  A mention is a token in code formatting — a key or an `id` value in a fenced JSON result, a
  single-backticked cell in the tables that list fields and verdicts — never a word in prose. The English
  word "hook" in the L2 level description is not an identifier, and a rule that flagged it would be
  demanding edits that make the documentation worse.
  
  **What the scan deliberately does not read.** Only blocks whose shape is a doctor result, and the
  field and verdict tables. The manifest and sync-report examples are left alone: their keys —
  `manifestVersion`, `strategy`, `counts` — belong to other vocabularies and are in neither list, so
  scanning them would have forced exactly the allowlist this design exists to avoid. A test states that
  exclusion rather than leaving it to be inferred from a regex.
  
  The gap that leaves is tracked rather than merely named. The scan *selects* the blocks it reads, and
  selection catches narrowing — a reworded heading fails — while being blind to a block of a new shape
  never joining the set at all. Replacing the selection with a partition, so that every JSON block must
  be classified and an unclassified one fails, is issue [#79](https://github.com/E1i/mikoshi-construct/issues/79).

- [#77](https://github.com/E1i/mikoshi-construct/pull/77) [`8084a24`](https://github.com/E1i/mikoshi-construct/commit/8084a24e5265497f84053781bca6ce065b40903b) Thanks [@E1i](https://github.com/E1i)! - `What it refuses to claim` described a version that no longer exists, which is an uncomfortable thing
  for a page about not overstating.
  
  It taught the old three states — `present`, `absent`, `unknown` — which were the check vocabulary
  before verdicts became projections of the model. The states are `held`, `unsupported` and `unknown`
  now, and the page gives each one the reading it is **not**: `held` is not *proven*, because the facts
  under a claim are necessary and never sufficient; `unsupported` is not *not enforced*, because a
  named fact stopped matching and the report says which; `unknown` is not *absent*.
  
  It also still said the harness question is "always `unknown`, because proving it means running it".
  That verdict is gone. A blind spot is represented by a stated boundary now, not by a verdict
  manufactured to fill the space — an answer nobody can act on is not a smaller finding than no answer,
  it is a worse one, because it looks like a finding.
  
  The levels table carries the precondition every level above `L0` was already assuming: the mechanism
  must be able to report a failure. And a new refusal joins the list — that a level it reports is
  proven — with the note that whether a mechanism could fail at all is an open question rather than
  something assumed either way.
  
  `getting-started` lists `construct.model.json` among the files a new repository gets, since it is
  committed and a reader meets it in their tree on the first run.

## 0.5.2

### Patch Changes

- [#75](https://github.com/E1i/mikoshi-construct/pull/75) [`1d04d5b`](https://github.com/E1i/mikoshi-construct/commit/1d04d5be2ca05567892832073583e72b6933e33b) Thanks [@E1i](https://github.com/E1i)! - The baseline fix in 0.5.1 repaired two things and only one was tested. Files compared against stale
  `init` hashes were reported modified, which is what prompted the work; a path recorded **only** by
  `sync` was never examined at all, which produced no symptom and so appeared in no test. It shipped
  repaired and unheld, free to regress as quietly as it arrived.
  
  It is held now: a path the `init` record never contained is reported missing when it is deleted and
  modified when it is edited. Reverting the fix fails all three cases.
  
  The case that asserts silence while the path matches passes under the defect as well, because never
  looking is also silent. Only the cases demanding a positive report tell the two apart — which is why
  they are the ones that matter here.

## 0.5.1

### Patch Changes

- [#71](https://github.com/E1i/mikoshi-construct/pull/71) [`211da72`](https://github.com/E1i/mikoshi-construct/commit/211da72236db1817fe9f00c2721381a861311407) Thanks [@E1i](https://github.com/E1i)! - `doctor` compared every path against the frozen `init` record and ignored everything `sync` had
  recorded since, so on any repository that has run `sync --apply` it reported the files sync had just
  written as modified. Found on a real tree, not a fixture: seven fabricated entries sitting beside
  nineteen genuine ones, with nothing in the output telling them apart, and one more added by every
  future sync.
  
  `construct.json` holds two records on purpose — the `init` record is frozen by decision 0006, and the
  sync record carries what has been written since. The latest recorded state for a path is the first
  overlaid by the second, which is what `recordedShas` has always returned and what `sync` itself
  reads. `doctor` simply did not use it. That was visible in the output before it was visible in the
  code: `versionGap` reached the sync record through `replay` while `modifiedFiles` did not, one
  sibling backed and the other bare.
  
  The same defect was in two more places. `uncollectedTests` looked for the runner config and
  enumerated recorded test files in the init record alone, so anything sync added was invisible to it.
  And `init` counted the records it carried over from an existing `construct.json` without the sync
  half, under-reporting what it kept and over-reporting what it added.
  
  Three occurrences make it structural rather than a bug to fix again, so the shared boundary is now
  enforced: reading `manifest.files` directly anywhere under `src/` fails lint, with `src/manifest.ts`
  the single exemption, since it is the file that defines what the two records mean.

- [#71](https://github.com/E1i/mikoshi-construct/pull/71) [`211da72`](https://github.com/E1i/mikoshi-construct/commit/211da72236db1817fe9f00c2721381a861311407) Thanks [@E1i](https://github.com/E1i)! - The model every repository gets from `init` claimed `vulnerable-dependencies-are-visible` at **L3**,
  and the job behind it ships with `continue-on-error: true` in `templates/base`. A job with that flag
  is marked successful even when its step fails, so the check is green whether or not a vulnerability
  was found. The claim asserted a level the mechanism cannot reach, in the release that shipped the
  model, in every repository materialized by it.
  
  The level is now `L0` and the mechanism says why: the audit runs on a schedule and on pull requests,
  reports into the log, and can never fail a check, so nobody is obliged to act on it.
  
  The scale reads `L3` as "CI that does not block a merge", which superficially fits — but that wording
  presumes a check able to report a failure at all, and distinguishes `L3` from `L4` by whether the
  failure blocks. A check that is green in both worlds carries no information and sits below the scale.
  
  The mechanism was left as it is rather than made to fail. A dependency audit reads an external
  advisory database, so making it block would fail on news rather than on the change, which is
  presumably why the flag was set. Lowering the claim to the truth is the repair; raising the mechanism
  is a separate question with its own costs.
  
  This is rule 8 applied to the tool itself — the presence of a command is not the level at which it is
  enforced — and the first case where a claim was `held` on facts that were all true while the
  mechanism it named could not fail. `supportedBy` gives necessary conditions, never sufficient ones.

- [#73](https://github.com/E1i/mikoshi-construct/pull/73) [`73f4d54`](https://github.com/E1i/mikoshi-construct/commit/73f4d540c1e6ce89af5235171c52b37e69b74cd4) Thanks [@E1i](https://github.com/E1i)! - The enforcement scale now states the assumption every level above L0 was already making: the
  mechanism must be able to **report a failure**.
  
  L3 read as "CI that does not block a merge", which literally describes a job carrying
  `continue-on-error` — it is CI, and it does not block. The wording presumed a check capable of
  failing and distinguished L3 from L4 by whether the failure blocks, without ever saying so. The
  distinction between L0 and L3 is whether a failure can be raised at all, and that half was never
  written down.
  
  A check that is green whether or not the invariant holds reports nothing and is L0, however much
  machinery stands behind it.
  
  This is a precondition being written out, not scope being added: it is what the levels already
  assumed, and exactly one record was affected by the gap — the dependency-audit claim corrected in
  this same release. Writing it now, while that single case is known and already repaired, means the
  sentence reclassifies nothing retroactively. Left for later it would silently move an unknown number
  of past records, and nobody would be able to tell a clarification from a change of scope.

## 0.5.0

### Minor Changes

- [#52](https://github.com/E1i/mikoshi-construct/pull/52) [`a572b5a`](https://github.com/E1i/mikoshi-construct/commit/a572b5ae6098dbf58431ce8c7d4442d4c51ab177) Thanks [@E1i](https://github.com/E1i)! - `init` now writes a second file beside `construct.json`: `construct.model.json`, a single
  machine-readable model of what this tool holds to be true about a repository. Nothing reads it yet.
  `doctor`, `sync`, the invariants table and every report work exactly as they did.
  
  The two files are separate authorities and stay that way. The manifest records file provenance — what
  `init` and `sync` wrote. The model records repository knowledge — what is claimed and how each claim
  is held. Neither reads state from the other, and that is a lint rule running in both directions rather
  than a sentence in a decision record: `src/model` cannot import `src/manifest.ts` and `src/manifest.ts`
  cannot import `src/model`. The rule shipped in the same change that named the modules, because a plan
  item promising enforcement later is itself only a promise.
  
  Three properties of the model are worth stating, because each one is a thing the schema refuses rather
  than a thing it offers.
  
  There is no state stored anywhere in the file, and the parser rejects a `state` property at any depth.
  A hypothesis is held by the facts named under it or it is not held at all, and that is computed on
  every read. A hypothesis whose supporting file has been deleted reports `unsupported` without anything
  having to notice the deletion.
  
  There is no confidence field under any name — not `confidence`, `strength`, `score` or `support`.
  Epistemic rule 7 separates confidence from evidence state, and a number beside a hypothesis is read as
  a probability. Whoever wants one has to change the schema and defend it.
  
  `unsupported` and `unknown` are different answers and the derivation keeps them apart. A fact that
  could not be evaluated at all — an unreadable path, a directory where a file was expected — leaves the
  hypothesis `unknown`. `unsupported` is reachable only when every named fact was actually evaluated and
  at least one does not hold. Rule 2 again: not having looked is not a finding, and a negative verdict
  needs full evidence exactly as a positive one does.
  
  An enforcement carries the facts that hold its level up rather than a bare level, which is rule 8 taken
  seriously — the presence of a mechanism is not the level at which it is enforced. A claimed L3 whose
  workflow has been deleted stops being held, where a bare `"level": "L3"` could never rot.
  
  The rule that picks where a chain stops being held ships here too, with the fixture that pins it, even
  though nothing renders it until the next step. Ties are reachable, and declaration order breaks them,
  because that is what stays stable in a diff.

### Patch Changes

- [#57](https://github.com/E1i/mikoshi-construct/pull/57) [`4b233d6`](https://github.com/E1i/mikoshi-construct/commit/4b233d6317e0f43e782506c3f811adb8e9fa44f2) Thanks [@E1i](https://github.com/E1i)! - The proof that a malformed model stops `init` before anything is written now runs against a repository
  the construct has actually materialized, rather than against an empty directory.
  
  The distinction is the whole point. In a real repository the model becomes malformed *after* the
  repository exists, so the invariant is that nothing was **changed** — not merely that nothing was
  created. The test now materializes a complete repository, breaks a `supportedBy` reference, snapshots
  every path in the tree with its bytes, and requires the tree to be identical after the failing run. The
  only path excluded from that snapshot is `construct.model.json`, which the previous step deliberately
  edited, and it is asserted separately so nothing is lost.
  
  A content snapshot alone would have proved less than it appears to, because `init` is deliberately
  idempotent: re-running it writes byte-identical content, so the comparison would hold whether or not
  the materialization step ran. The test therefore deletes a file `init` is known to create before the
  failing run and requires it to still be absent afterwards, which can only be true if the run stopped
  first. A sibling test deletes the same file with the model intact and shows `init` does bring it back,
  so the probe is known to be live rather than a file that was never going to return.
  
  The error assertion now covers the whole safety contract rather than part of it: the file, the missing
  fact, that nothing was replaced, and both ways out — putting the fact back, or dropping the reference
  that names it. Those two clauses exist so that deleting the committed record never looks like the
  remedy, and they are now protected against a later wording change.

- [#66](https://github.com/E1i/mikoshi-construct/pull/66) [`e692a53`](https://github.com/E1i/mikoshi-construct/commit/e692a5341284b09bb3c526f67233a88c76475456) Thanks [@E1i](https://github.com/E1i)! - `doctor` no longer dies on a repository it cannot fully read, and no longer reports clean over a tree
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

- [#60](https://github.com/E1i/mikoshi-construct/pull/60) [`37187c5`](https://github.com/E1i/mikoshi-construct/commit/37187c5e9580288db0a7f677d8ffc8787d7229d2) Thanks [@E1i](https://github.com/E1i)! - Two records about a state that is about to become the common one: a repository with no
  `construct.model.json` at all.
  
  The model is written only by `init` and is not materialized from templates, so `sync` never creates
  one. Every repository materialized before 5.0 and carried forward with `sync` therefore arrives at 5.1
  — the step where `doctor` starts reading the model — without a model to read.
  
  5.1's acceptance now requires that case explicitly. Absent is a third state, distinct from empty and
  from malformed, and by rule 2 it is `unknown`: `doctor` must complete on such a repository and say
  plainly that it knows nothing about claims there. A `doctor` that fails, or one that reports claims as
  `absent`, would turn missing data into an assertion about enforcement, which is the error the rule
  exists to prevent.
  
  How such a repository eventually gets a model is recorded as an open question rather than settled:
  `sync` could write one, an explicit command could, or nothing could until the next `init`. Each trades
  differently against the line 0016 draws between file provenance and repository knowledge, and the
  no-model acceptance has to land before the choice, not after — it is what makes the cheapest option
  survivable.

- [#68](https://github.com/E1i/mikoshi-construct/pull/68) [`16e7e20`](https://github.com/E1i/mikoshi-construct/commit/16e7e20d0ce68e4eaff7589336a0fa3ec22bdc51) Thanks [@E1i](https://github.com/E1i)! - A repository with no `construct.model.json` now reads as one, instead of reading as a repository in
  perfect health. Run `doctor` on such a tree before this change and the Enforcement section was empty
  with nothing said about why, and the last line read `You are here: no claim stops before the end of
  its chain` — a sentence rendered from `youAreHere: null`, which `selectPath` returns both when every
  chain is complete and when there are no chains at all. The two collapsed onto the reassuring side,
  which is the direction nobody reports as a bug, and after 0.6.0 it is the majority of repositories:
  the model is written only by `init` and never by `sync`.
  
  The distinction now lives in the data rather than in the renderer's inference from an empty list.
  `youAreHere` is a discriminated union carrying `at`: `no-model` (there is no `construct.model.json`,
  so nothing was read and nothing is known about what the repository claims), `no-claim` (it was read
  and it names none), `no-stop` (it carries claims and none of their chains stops), and `stop` (the
  first chain that stops, under `stop`). Reading `no-model` as `no-claim` is not a wording mistake the
  next renderer can make: the shapes are different, and the case that used to be silent has to be
  handled to compile. The Enforcement section says which of the first two it is rather than printing an
  empty list a reader would take for a clean repository.
  
  None of this is a failure and none of it moves `ok`: **the exit code does not change for this case**
  — a repository with no model still exits `0`. Absence of a subject is not obstruction, and by
  [rule 2](architecture/epistemic-rules.md) not having looked is not a finding; saying nothing is known
  is not saying nothing is enforced. No verdict is reported as `absent`, `doctor` writes no model and
  repairs none, and how a repository acquires one stays the open question it was.
  
  `doctor --json` changes shape at one field: `youAreHere` is `{at, stop?}` and is never `null`.
  
  Three fixtures cover the three situations — no model, a model naming no claim, a model whose chains
  all hold — and each asserts the **rendered line**, not only the structured value, because the defect
  was invisible in the JSON and visible only in the text.

- [#59](https://github.com/E1i/mikoshi-construct/pull/59) [`b9668e8`](https://github.com/E1i/mikoshi-construct/commit/b9668e87c67f9e7bc6784ec13d72ebefee653138) Thanks [@E1i](https://github.com/E1i)! - `architecture/epistemic-rules.md` now says that a rule's normative scope is fixed once written. New
  scope takes a new number; an existing rule may gain a "see also" reference to it, never additional
  scope of its own.
  
  The header already promised stable numbering, and that promise is easy to misread as making the rules
  safely extensible. It is not, and the two guarantees are different. Stable numbering protects what a
  reference points at. This protects what it means: widening an existing rule would silently change what
  every citation of it already asserted, across decision records and commit messages nobody is going
  back to reread. A rule that stops applying is struck through in place for the same reason.
  
  The open question about evidence of enforcement capability now carries the constraint concretely. If
  it resolves towards being a repository fact it becomes a new rule, not an expansion of rule 8 — *a
  command exists → the enforcement level* is rule 8, and *the enforcement level → the capability
  demonstrated* would be the new one. Adjacent in meaning is the argument for two numbers rather than
  against.

- [#65](https://github.com/E1i/mikoshi-construct/pull/65) [`4d4380a`](https://github.com/E1i/mikoshi-construct/commit/4d4380a2ea391f7aab7d980221e7bf2093a80eed) Thanks [@E1i](https://github.com/E1i)! - `doctor` stops assembling its own picture of enforcement and becomes a projection of
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

- [#67](https://github.com/E1i/mikoshi-construct/pull/67) [`8240074`](https://github.com/E1i/mikoshi-construct/commit/8240074017e4c8387f553c05d3a648c532c7c973) Thanks [@E1i](https://github.com/E1i)! - `harnessProblems` was classified `mixed` last release, deliberately and temporarily: half of what it
  returned asserted enforcement and half was provenance, and calling it either would have been a
  statement known to be false. It now splits along the rule
  [architecture/model.md](architecture/model.md) already states — a verdict is knowledge when it can
  become false without anything `init` wrote changing, and provenance when it goes false only when
  what `init` installed has changed.
  
  The step-coverage entries leave the field. *"quality" does not run lint*, *typecheck*, *test* and
  *contracts:check* asked about a `package.json` script that belongs to the repository's owner, who can
  rewrite it tomorrow with no construct file touched. They are read off the `harness-steps` claim
  instead, which already carried the first three; where a preset materializes an HTTP contract, that
  command's `contracts:check` step now stands under the same claim rather than nowhere.
  
  What stays in `harnessProblems` is the record around the command: `package.json` is gone, it has no
  script under the name `construct.json` recorded, or a contract path that manifest points at is
  absent. The field is `provenance`, and the `mixed` value is deleted rather than left as a member
  nothing uses.
  
  **The exit code does change, for one case.** A repository whose harness command stopped running
  `lint`, `typecheck` or `test` used to make `doctor` exit non-zero, because that assertion lived in
  `harnessProblems` and `ok` consumes that field. It is now an unsupported claim instead, and `ok` no
  longer moves for it.
  
  That follows from the correction rather than sitting beside it. `ok` is a provenance answer: it says
  whether the construct's own installation is intact and fully inspectable, and it says nothing about
  what is claimed of the repository. A step-coverage assertion was never provenance — a `package.json`
  belonging to the repository's owner can stop calling the right command with no construct file
  touched — so `ok` consuming it was downstream of the misclassification this release fixes.
  
  If you script on the exit code and relied on it catching a harness that had stopped running its
  steps, read `checks` for the `harness-steps` claim instead. The report still says so, and says it
  more precisely than before: it names the fact that stopped matching.
  
  The scope is now enforced rather than described. `ok` is computed by a function whose argument type
  is derived from the classification and contains only the provenance fields, so reading a knowledge
  field while computing it does not fail a test — it fails to compile. That replaces a claim about two
  points in time, which nothing observing one point can hold, with a claim about where the value comes
  from, which is true or false today.
  
  The promise the previous release made is now closed by a test rather than by memory: no field is
  classified `mixed`, none carries a family the code does not declare, and none escapes the question.
  Gate A covers `harnessProblems` with no edit to the gate's own source — it reads the classification,
  which is demonstrated by reclassifying the field in the gate's input and watching the gate speak
  about it.

- [#54](https://github.com/E1i/mikoshi-construct/pull/54) [`6920510`](https://github.com/E1i/mikoshi-construct/commit/692051012ef2109509cb84d733f3e694fe13bd2d) Thanks [@E1i](https://github.com/E1i)! - A second `init` no longer replaces `construct.model.json` wholesale. The model is a committed record
  meant to be read and edited by hand, and discovery will write hypotheses into it, so overwriting it on
  every run was a way to lose authored content quietly. `init` now owns exactly the entries it wrote —
  those whose `authoredBy` is `construct` — and carries everything else over untouched, which is what
  decision 0013 already settled for the manifest.
  
  For that rule to be expressible, authorship had to become uniform. Facts carry an `authoredBy` like
  claims and hypotheses already did, and all three read it from one list: `construct`, `discovery` or
  `unknown`, the same vocabulary the manifest uses for a discovery marker. A construct-authored entry the
  preset still makes is rebuilt in the place it already held; one the preset no longer makes is dropped,
  unless a surviving entry still stands on it, because a dropped fact would take referential integrity
  with it. Surviving entries keep their relative order and only new entries are appended, since
  declaration order in `claims` is what breaks a tie when two chains stop at the same stage.
  
  The corollary is the thing to remember when editing the file: an entry that still says it was authored
  by the construct is the construct's to rewrite. Change its author and the edit survives. There is no
  force flag, no backup file and nothing that refuses to write.

- [#63](https://github.com/E1i/mikoshi-construct/pull/63) [`b9083ea`](https://github.com/E1i/mikoshi-construct/commit/b9083ea574d06d25fa5db7681c0d53fdce158d40) Thanks [@E1i](https://github.com/E1i)! - The enforcement levels are now one list rather than two kept in step. `src/model/schema.ts` owns
  `ENFORCEMENT_LEVELS` and `doctor` imports it; `LEVELS` remains exported under its own name, so nothing
  that consumed it has to change and `doctor --json` is byte-identical.
  
  The audit in the previous release found the levels declared twice and tied the copies together with a
  test, because `doctor` could not read the model at the time and a stopgap was the honest thing to ship.
  A guard that confirms two copies agree, kept indefinitely, ends up blessing the duplication it was
  meant to be temporary cover for — so now that `doctor` can import from the model, the second copy is
  gone rather than supervised.
  
  The test changed with it, from asserting that the two lists agree to asserting there is only one. It
  compares by identity rather than by value, which is what makes it able to catch the thing worth
  catching: a reintroduced list with the same five entries fails, where a value comparison would have
  passed and gone on passing until somebody widened one of them.

- [#62](https://github.com/E1i/mikoshi-construct/pull/62) [`a56a3dc`](https://github.com/E1i/mikoshi-construct/commit/a56a3dc67f311368192cf02e39052a5693d35bee) Thanks [@E1i](https://github.com/E1i)! - The rule that a normative scope is fixed once written now has an audit behind it, and one gap it found
  has a check.
  
  Two identifier vocabularies in this repository are cited by name and would rewrite history if their
  meanings moved: `doctor`'s check ids, which every report already published asserts something with, and
  the enforcement levels L0–L4, which every invariant already recorded at L3 depends on.
  
  The check ids are clean. Five ids in five files, each declaring its own and emitting no other, and `ci`
  goes further by naming in a constant what it cannot see — branch protection lives in the GitHub API —
  rather than quietly covering it.
  
  The levels were not. They were spelled out twice in code, once for `doctor` and once for the model,
  with nothing tying the copies together. They agreed, so nothing was wrong; but either could have been
  widened on its own and no check would have failed, which is precisely the silent move the scope rule
  forbids. A test now holds the two lists to each other, verified by widening one and watching it fail.
  
  The audit is recorded with its date and with what it inspected, because an unexamined vocabulary and a
  clean one look identical from the outside.

- [#55](https://github.com/E1i/mikoshi-construct/pull/55) [`bc99fed`](https://github.com/E1i/mikoshi-construct/commit/bc99fed9f85001fa90b9c60744e190cfb818af50) Thanks [@E1i](https://github.com/E1i)! - `architecture/model.md` now states how ownership inside the repository model is determined:
  `authoredBy` is the sole source of it. `init` may replace only entries authored by `construct`, and
  entries with any other author are carried over unchanged.
  
  The rule was already what the writer does, but it lived in the writer's implementation and in a
  reviewer's head, which is L0. The next consumer that needs to know who owns an entry would have
  derived it some other way — from what references it, from whether the preset still produces it, from
  where it sits in the file — and the model would have had two answers to one question. The document
  names the derivations that are not permitted, rather than only the one that is.
  
  It also says plainly that nothing checks this mechanically: the rule is held by review. That is the
  honest level for a sentence, and stating it is better than letting a reader assume a test stands
  behind it.

- [#64](https://github.com/E1i/mikoshi-construct/pull/64) [`43e04e5`](https://github.com/E1i/mikoshi-construct/commit/43e04e5ab937ab6d8851043c16c6a22614b8b95a) Thanks [@E1i](https://github.com/E1i)! - The model now carries two claims it was missing. `harness-steps` says that the harness command runs
  lint, typecheck and tests rather than merely existing as a script, grounded in the script body
  `package.json` actually holds — `pnpm lint`, `pnpm typecheck`, `pnpm test`, as the harness template
  writes them — never a bare word like `test`, which matches half a manifest by accident. `lint-policy`
  says the declared lint policy is itself checked by a test, and exists only where the preset's sample
  group was materialized, because only there did `init` write the test it stands on. A claim with no
  materialized file behind it is worse than no claim at all, so the condition is part of the claim, not
  a caveat beside it.
  
  `doctor` still computes its own verdicts; nothing under `src/commands/doctor` changed and
  `doctor --json` is byte-identical. What changed is that every one of its check ids now has a recorded
  decision about where its verdict belongs, asserted over an enumeration derived from `CHECK_IDS` rather
  than from a list retyped in the test. The mapping is not one-to-one — `ci` maps onto a claim that
  already existed, `construct-tests` is provenance, `hook` and `red-gate` are dropped with their reasons
  — and that is the hazard the test closes: a check with no claim of its own is indistinguishable from a
  forgotten one unless somebody wrote the decision down. A new member of `CHECK_IDS` with no entry now
  fails the suite by name.
  
  `architecture/model.md` gains the two rules behind that. Why a `Claim` carries exactly one enforcement,
  so that CI and a local hook are two claims about two mechanisms and not one claim read as a duplicate;
  and the test for where a verdict belongs — knowledge if it can become false without anything `init`
  wrote changing, provenance if it becomes false only when what `init` installed has changed, with
  `harness-steps` and `construct-tests` worked through as the two sides.

- [#69](https://github.com/E1i/mikoshi-construct/pull/69) [`68ec7c3`](https://github.com/E1i/mikoshi-construct/commit/68ec7c36210ed89b56e09cbbfa1f48e02bec08c1) Thanks [@E1i](https://github.com/E1i)! - The you-are-here line now names the fact that stopped matching, instead of stopping at the claim and
  the stage.
  
  It is the one line a reader sees if they see one line, and it is the line most often read apart from
  everything around it — torn into a CI log, a grep result, a forwarded snippet. A line that pointed at
  the verdict above it would say nothing in exactly the places it actually gets read, so it says the
  fact itself. The verdict and the line are two projections of one value rendered in one run; they
  cannot drift, and a second store is what the no-duplication rule forbids.
  
  Length is bounded by form rather than by truncation: a stage with several failing facts names one and
  counts the rest — `package.json, and 2 more` — with the full list staying in the verdict. A stage that
  could not be read names no fact, because nothing was established about it. The facts are a required
  argument of the call that renders the stopped line, so a line claiming a stop without naming one
  cannot be written.
  
  The three situations with no path — no model, a model carrying no claim, a model whose every chain
  holds — read exactly as before.
  
  A stage that could not be read names the path it could not read, and still blames nothing. Naming
  what was unreadable is information; naming a fact as failing when none did would be the substitution
  this release exists to remove, and the two are easy to confuse. Without the path the line said that
  *something* could not be read — true, and useless to anyone reading it out of a CI log, which is the
  one thing this line is for.
  
  Where several facts stopped matching the count says what it is counting — "and 2 more facts" rather
  than "and 2 more" — because the line is read where nothing around it explains the number.

- [#56](https://github.com/E1i/mikoshi-construct/pull/56) [`b54a4bc`](https://github.com/E1i/mikoshi-construct/commit/b54a4bcf66a97f268cf805dba0d29ff59ee62161) Thanks [@E1i](https://github.com/E1i)! - The rule that a construct-authored fact survives while an entry the construct does not own still
  stands on it, and the rule that a model naming a fact nobody declares does not parse, are the same
  invariant read from two sides: `init` cannot produce a model the next `init` cannot read. That was
  true and untested. It is now proved through `runInit` itself, for both ways an entry reaches a fact —
  a discovery-authored hypothesis, and a claim standing on one fact through its enforcement and another
  through its verification — and it is proved against the file on disk rather than against the merge
  function, so it still holds if the set of facts stood on is computed differently tomorrow. The
  opposite direction is asserted by the same run: a construct-authored fact nobody stands on is still
  dropped.
  
  `writeModel` now parses the bytes it is about to commit and refuses to write them if they would not
  parse, which turns a retention regression into a failure at the moment it would create the unreadable
  record instead of a puzzle on the next run. The one remaining way to reach a model that cannot be read
  is by hand, so a dangling `supportedBy` gets an error of its own that names `construct.model.json`,
  names the missing fact, and says the model was neither written nor replaced — the safe recovery is
  putting the fact back, not deleting the committed record. The existing model is read and validated
  before anything is materialized, so that failure leaves the directory exactly as it found it.
  
  When the merge does keep a fact for an entry it does not own, `init` says so, next to the lines that
  already report what it carried over.

- [#58](https://github.com/E1i/mikoshi-construct/pull/58) [`199b8eb`](https://github.com/E1i/mikoshi-construct/commit/199b8eb48b96d53178a4e9037997461c04836231) Thanks [@E1i](https://github.com/E1i)! - A question this line of work opened is now recorded as open rather than carried in a thread.
  
  The model represents the declared enforcement mechanism and evidence that the mechanism exists and
  runs. It does not represent evidence that the mechanism can actually fail when the invariant it
  protects is violated — and those are different facts. A workflow that runs is not the same as a
  workflow that would catch anything.
  
  Two kinds of evidence for that capability have now been seen. Harness mutation tests are the
  deliberate kind. The atomicity work added an observed one: the ladder's `testsWeakened` guard caught a
  narrowed assertion inside a live implementation change, not in a fixture built to be caught. Whether
  enforcement capability is therefore a fact about a repository that the model should carry, or process
  evidence belonging to the corpus and the harness history, is genuinely undecided.
  
  It stays undecided on purpose. The question is not resolvable before `doctor` reads the model on a
  real repository and a real diagnosis shows what it actually needs, so 5.1 carries a review-level check
  that looks for exactly that and returns here if it finds one.
  
  Until then the blind spot is represented by the absence of a question the model can answer. It is not
  represented by an `unknown` value or any derived equivalent, because `unknown` asserts that something
  was asked and came back empty, and nothing has been asked.

## 0.4.0

### Minor Changes

- [#50](https://github.com/E1i/mikoshi-construct/pull/50) [`c226031`](https://github.com/E1i/mikoshi-construct/commit/c22603160ddd90cf5253f8305a5c5701a315f504) Thanks [@E1i](https://github.com/E1i)! - A run whose design step ran out now names the way out of it. The result carries a `recovery` field and
  the log says the same thing: re-run this task one class lower with the design written into the brief.
  
  That is not advice, it is the measured route. Three of the three occasions it has been tried on the
  construct's own repository produced the design the architect had failed to return — which is a better
  record than anything the ladder does automatically, and it cost almost nothing, because the person
  already had the design in their head when they wrote the brief.
  
  The message also says why the run does not simply try again, because a route offered without that
  reads as a missing feature: a second agent entry pays for the exploration again, 385k to 1.48M tokens
  on this repository, against one more attempt inside an entry already paid for at 57k to 100k. That is
  decision 0008, and it stays as it is. What was missing was not a retry but a sentence, and its absence
  left a dead end where there was a documented path with three successes behind it.
  
  `/implement` relays `recovery` verbatim, because a dead end that names no way out is how the next
  person concludes the ladder is broken rather than that this run wants re-running lower.

### Patch Changes

- [#47](https://github.com/E1i/mikoshi-construct/pull/47) [`a4c586e`](https://github.com/E1i/mikoshi-construct/commit/a4c586e3b7ad2bbd48225b7332d3115f9e20df16) Thanks [@E1i](https://github.com/E1i)! - A capture harness for the design step, built so that it cannot repeat the defect that cost the last
  investigation its answer. `pnpm bench:architect` runs the architect alone — one brief, one
  invocation, no implementer and no harness agent — and records, for every call: the payload whole with
  no cap, the byte offset at which parsing fails, the character sitting at that offset and its
  surroundings, every control character anywhere in the payload with its offset and name, the reason
  generation stopped, and the output token count.
  
  It streams with `eager_input_streaming` and accumulates the raw fragments itself rather than reading
  the SDK's parsed input, because both of those layers would repair or silently truncate exactly the
  bytes in question: the server validates a buffered tool parameter before emitting it, and the SDK
  accumulates fragments with a tolerant parser that returns a shortened object instead of raising. The
  harness holds what the model actually emitted, and the whole stream consumption is wrapped so that a
  payload survives even when the SDK rejects it.
  
  The classifier separates the two things the old record could not tell apart: an escaped `\n` inside a
  value, which is legal and parses, and a raw newline, which is not and does not. It names each refusal
  as `control-character`, `ended-early`, `not-an-object` or `unnamed`, and a test exercises every one of
  those names against a handwritten payload, including the pair that is the whole open question.
  
  The corpus is the nine real briefs from this repository's own ladder runs, frozen alongside the
  outcomes they produced. Using our own briefs rather than another project's keeps the measurement free
  of someone else's material and costs nothing, because the defect is in the shape of the output and not
  in the subject of the task. The schema and the instructions come from the ladder script and the
  architect agent file rather than being restated, so the harness measures the contract that ships.
  
  Its first run is diagnostic, not acceptance — the script says so before it does anything, and says
  that no result from it may be reported as a rate. A rate is measured afterwards, against whatever
  cause the diagnosis names. The script also refuses to spend money without `--yes`, and nothing about
  it is wired into `pnpm run quality`.

- [#48](https://github.com/E1i/mikoshi-construct/pull/48) [`4f3c840`](https://github.com/E1i/mikoshi-construct/commit/4f3c840ff88eeaed857e4efc30aca3ae0eab8a5a) Thanks [@E1i](https://github.com/E1i)! - `construct cost` counted every response two or three times, and the numbers this project has been
  publishing and deciding with were about twice their true size.
  
  The reader summed the `usage` of every assistant line in an agent's journal. The journal writes one
  line per content block of a response — thinking, text, tool call — and repeats that response's `usage`
  on each of them. So a run's cost grew with how many blocks its answers happened to be split into. It
  now deduplicates by request identifier, and a test fails if it stops: one response counted once
  however many lines carry it, two responses counted twice, and a line the runtime recorded without an
  identifier still counted, so the fallback is deliberate rather than accidental.
  
  Every figure this defect produced has been re-derived from the run it names and corrected where it was
  published. The release note for 0.3.0 and the reasoning-budget guide carry the correction with the
  method named rather than a silent swap of digits, and both say plainly that the comparisons they make
  are unaffected: the same bias ran through every figure, so what the numbers were used to argue —
  that the entry into the repository dominates, that it grows with the repository rather than the task,
  that the reasoning class predicts the price poorly — stands exactly as written. What was wrong was
  every absolute number. The four architect entries that returned nothing burned 8,312,965 tokens rather
  than 18,580,617; the same role grew 1.19M, 2.05M, 3.16M, 3.91M across one day rather than 2.9M to 8.5M.
  
  Decision 0008, which chose `retryLimit: 0`, is amended rather than reopened. Its conclusion survives,
  but the ratio under it does not: splitting five architect entries at their first structured-output call
  measures the exploration a new entry pays at 385k to 1.48M and one further attempt inside an entry
  already paid for at 57k to 100k, so the margin is five to twenty to one and not the thousand to one
  the release note claimed. The amendment also records an argument against its own conclusion that the
  evidence did not previously contain — a refused answer recovers, twice observed, and the entries that
  died had exhausted the runtime's internal attempts — with its price attached and a note that the next
  measurement must weigh it again.

- [#49](https://github.com/E1i/mikoshi-construct/pull/49) [`942ae87`](https://github.com/E1i/mikoshi-construct/commit/942ae87de93bf0c4c5af2b274953218081bcbc3e) Thanks [@E1i](https://github.com/E1i)! - A source file that both git and eslint ignore is checked by nothing, and a test now names any that
  exists. That is the shape behind the `bench/` pattern which hid `scripts/bench` from version control
  and from the linter at once: each reader answered honestly about the set it was shown, and neither
  said anything about what had fallen out of it.
  
  The invariant is deliberately weaker than "both readers see every file", because one-sided exemptions
  are legitimate and declared — `templates/` is tracked and not linted on purpose, captured payloads are
  written and not tracked on purpose. What must never happen is that a source is exempt from both at
  once, because then nothing is left holding it.
  
  It is built on git's ignore decision rather than on what git tracks, which matters: `git ls-files`
  reports an already-committed file as tracked whatever `.gitignore` says, so a check written against
  tracking passes over the very defect it is meant to catch. The first version of this test was written
  that way, and reintroducing the real `.gitignore` pattern left it green. It is proven the other way
  now — the test writes a source file into a directory both readers skip and requires the check to name
  it — and that probe, not the assertion over today's tree, is what says the check works.

- [#44](https://github.com/E1i/mikoshi-construct/pull/44) [`1b95f34`](https://github.com/E1i/mikoshi-construct/commit/1b95f34c93029fed2c31356ccdbb8fd28ad0a4ee) Thanks [@E1i](https://github.com/E1i)! - Ten `StructuredOutput` calls the runtime refused are frozen as fixtures, harvested from two architect
  entries that died in the Design phase of one `/implement` run on a repository this construct had
  materialized: two tasks entered Design, and neither returned a design or a line of code. The
  journals of that run live under `~/.claude/projects/` and go away with the first cleanup of that
  directory, so this record could not have been made twice.
  
  They were harvested before anything was fixed, because the fix that seemed obvious is not the one the
  record supports. Seven of the ten calls never reached schema validation at all: the runtime could
  not read the input as JSON and said so, naming sizes from 3436 to 10 293 bytes. The other three
  arrived as an object with no properties. A bound declared on the schema is a limit the validator
  applies *after* an input parses, so for seven of these ten it would have changed nothing — and both
  agents had already
  shortened their answer twice over and been refused each time, one of them at 3436 bytes. Size alone
  does not separate a call that works from one that does not.
  
  Every recorded completion stopped with `tool_use` rather than `max_tokens`, so the model considered
  each of these calls finished. All ten ran at `xhigh`, the effort the ladder gives Design.
  
  The accompanying note draws the line between what the runtime reported and what the logger kept: the
  journal stores the first 2048 characters of a tool input, so the stored payloads are prefixes that are
  themselves cut off, and the bytes at which these answers actually became invalid are gone. A test that
  proved one of these prefixes fails to parse would have proved something about the logger. The
  vocabulary of the private project's product surface is replaced the way the frozen manifests were,
  the arity and shape of each list kept, and the two task briefs are not stored at all because they
  named a private repository and the accounts that own it.

- [#46](https://github.com/E1i/mikoshi-construct/pull/46) [`1f7baa5`](https://github.com/E1i/mikoshi-construct/commit/1f7baa567f9c90916bde475d84007007bbe31d08) Thanks [@E1i](https://github.com/E1i)! - Every architect entry this repository's own `/implement` runs recorded is frozen as a fixture, and the
  accounting it produces is worse than the one the rejected payloads showed. Nine entries: three
  returned a design, four returned nothing, and **two returned a design in which every value is a
  placeholder and were recorded as a success**.
  
  Both of those came after three payloads the runtime could not read. The answer that finally passed was
  `decision: "test"`, `contractChanges: "test"`, `compositionChanges: "test"`, `constraints: ["a"]`,
  `acceptance: ["a"]`, `files: ["a"]`. The schema accepted it because the schema constrains shape and
  never content, the run moved on to the Implement phase, and the implementer was handed `Acceptance
  criteria: - a` and `Design spec from the architect: test`. Nothing was red. Six of the nine entries
  produced no usable design and only four of the six were visible as failures.
  
  The same nine runs settle the question the rejected payloads left open. The three real designs are
  10 667, 13 963 and 17 081 bytes; the largest was accepted on the first attempt, with a
  2481-character `decision` and 416 backticks among its values, while the smallest payload the runtime
  is known to have refused was 3436 bytes. The size of an answer does not separate one that is accepted
  from one that is refused, so a remedy that shortens the answer is aimed at something these runs
  contradict — and the two placeholder designs are a recorded example of what shortening degenerates
  into under retry pressure.
  
  The nine briefs are kept in full. They are real task statements from this repository, of the shape
  that produces a long spec, and they are the corpus a measurement of the design step should run
  against, which keeps that measurement free of any other project's material.
  
  Freezing them also found a false positive in the privacy guard: a bare hostname mentioned in prose was
  matched case-insensitively, so the TypeScript property access `WorkflowRun.run` inside a recorded
  design read as a domain on the `.run` TLD. A bare mention must now be lowercase, which is how
  hostnames are written; a capitalised host inside a URL or an e-mail address is still reported.

- [#45](https://github.com/E1i/mikoshi-construct/pull/45) [`87eac7b`](https://github.com/E1i/mikoshi-construct/commit/87eac7b835fe7ba299ac095d8042b5c79022485d) Thanks [@E1i](https://github.com/E1i)! - The ten frozen architect rejections are read by a test that says what they can and cannot establish,
  before anything is changed to stop them happening. Most of what they looked like they established
  turns out to belong to the log they were recorded in.
  
  All seven payloads the runtime could not parse were cut at exactly 2048 characters, which is the
  length that log keeps, while the runtime reported 3436 to 10 293 bytes for the same calls. Any pattern
  at that edge is drawn by the recording, so the field the text happens to stop inside is not evidence
  about the answer, and between 1388 and 8245 bytes of every payload — the part that would name the
  cause — is gone and cannot be recovered.
  
  What sits inside the window is evidence. Every payload begins at `{` with no fence and no prose around
  it, not one raw control character survives anywhere in what was kept, and `decision` — the long
  free-prose field that the obvious remedy would have bounded — opens the object and closes cleanly at
  1255 to 1809 characters, correctly escaped, in all seven. The malformation is therefore somewhere
  after `decision`; which of the five fields after it, and whether any of those is clean, this record
  cannot say. Every recorded completion stopped with `tool_use` rather than `max_tokens`, and the output
  sizes span more than a factor of three with no ceiling they cluster under, which counts against an
  answer that ran out of room without settling it.
  
  The three calls that passed no arguments at all are split off as their own class, because they are the
  only failure recorded whole: `{}` is the entire input the runtime received. Each spent a turn and then
  sent nothing, and each followed at least three attempts already refused, so nothing about them depends
  on how long an answer is.
  
  The consequence is an ordering. A measurement of how often the design step fails has to capture the
  whole payload, the byte offset at which parsing fails and the reason generation stopped, or it will
  reproduce the defect that cost this record its answer: twenty invocations would yield a rate and still
  not name a cause. Its first run is diagnostic, not acceptance.

## 0.3.1

### Patch Changes

- [`0070441`](https://github.com/E1i/mikoshi-construct/commit/00704415b443b3a590b6cf9da32fe256951f2a9d) Thanks [@E1i](https://github.com/E1i)! - **A green release run now has to mean the version is installable.**
  
  Publishing 0.3.0 ended green — `Successfully published`, a git tag, a GitHub release — with nothing on
  the registry. The version had gone into npm's staged-publish state, which a stage-only trusted
  publisher produces by design and which no CI token can approve; the next run exposed it with `409
  Cannot publish over previously staged version`. The pipeline had reported a success the world did not
  contain.
  
  A separate `Release verification` workflow now asks the registry about the version in `package.json`
  after every release, and can be re-run on its own once a human approves a staged version — re-running
  the release itself would only publish again and fail on the 409.
  
  It answers with three outcomes rather than a boolean, because the rule this release is built on
  applies to its own guards: `installable`, `absent`, and `unreachable` for a request that could not be
  made. A network error is never read as a missing version. And when a version is `absent` the message
  names both worlds it could mean — a staged publish awaiting approval, or a publish that failed while
  reporting success — because CI cannot tell them apart and picking one would be the same defect again.

- [#42](https://github.com/E1i/mikoshi-construct/pull/42) [`5b20037`](https://github.com/E1i/mikoshi-construct/commit/5b2003756b3396488bacad993c5fe4f0e03d1e92) Thanks [@E1i](https://github.com/E1i)! - **The documentation link comes first, where a reader on npm actually sees it.**
  
  The link to the site existed but sat below the install snippet and the version note, which on the npm
  package page is under the fold. It is now the line directly beneath the description, with the four
  destinations worth naming: the site, getting started, the development cycle and the CLI reference.
  
  A test keeps it that way and keeps it true: every `e1i.github.io` link in the README must resolve to a
  page this repository builds, and the documentation must be named before the install snippet. The
  README travels to npm, where nothing checks it and a dead link stays dead until the next release.

## 0.3.0

### Minor Changes

- [#41](https://github.com/E1i/mikoshi-construct/pull/41) [`1a20f9e`](https://github.com/E1i/mikoshi-construct/commit/1a20f9ee33a361ac9fa497d0e699772013b8adbf) Thanks [@E1i](https://github.com/E1i)! - The construct now materializes `architecture/decisions/` — a decision-record index that names the
  sections a record carries and the enforcement scale from L0 to L4 — so a generated repository has the
  directory the principles point at instead of only a claim that it does.

- [#30](https://github.com/E1i/mikoshi-construct/pull/30) [`5912518`](https://github.com/E1i/mikoshi-construct/commit/5912518c4a268fd4f40cf7546842755fc55757e7) Thanks [@E1i](https://github.com/E1i)! - `construct doctor` names the version that materialized the repository, the version reading it, and how many recorded paths a `sync` would add or update. The count is the sync engine's own classification — doctor replays and counts the paths classified `add` or `update` rather than asking the same question a second way, so the number it prints and the number `sync` acts on cannot drift apart. A replay it cannot run reads as "cannot be established" instead of as zero.
  
  It is evidence on the baseline check, not a sixth gate: no level, no part of the weakest link, no change to any exit code. A baseline that has moved on is work that became available with a release, which is also why `docs/cli.md` now says plainly that a non-zero `sync` exit after a release is not a fault and that `sync` does not belong in a quality gate.

- [#28](https://github.com/E1i/mikoshi-construct/pull/28) [`533b03e`](https://github.com/E1i/mikoshi-construct/commit/533b03ea2755ba05e46271ba27628496d8553a7a) Thanks [@E1i](https://github.com/E1i)! - Two guards against things that pass green.
  
  An acceptance test now asserts what a generated project *is*, not only that it works: `CLAUDE.md` and `AGENTS.md` carry the project name as their heading. Earlier today a change deleted that heading from the template as a side effect of something else, and nothing went red — the acceptance matrix proves a generated project installs and passes its own harness, and says nothing about what its documents contain. Where a product makes no claim there is no violation, which is the rule that protects a repository from being scolded for an unpromised improvement, read from the other side: anything asserted nowhere can be cut in silence. Removing the heading now fails the suite.
  
  And the `/plan` command, here and in the copy that ships, gains one line: a criterion is verified by what the task changes itself, and if satisfying it needs an action outside the task it belongs to that task. Twice in two days a specification, not an implementation, sent work outside its own boundary — once asking a reader for fields no writer produces, once asking a task to record a state only a later manual step creates.

- [#34](https://github.com/E1i/mikoshi-construct/pull/34) [`c5b63da`](https://github.com/E1i/mikoshi-construct/commit/c5b63da35092f753611d8d04426e8809da560cb3) Thanks [@E1i](https://github.com/E1i)! - A replay no longer demands a value the tool can establish for itself. The manifest records the owner's decisions; the detector establishes facts about the repository; a fact the manifest lacks is established at replay rather than asked for. Three real repositories could not run `sync` at all because their manifests, written by 0.1.0, carry no `compositionDir` — a directory the detector finds by looking for it. They were being told to hand-edit `construct.json`, the one action the tool's own decision record says destroys evidence of intent irrecoverably: forbidden in the documentation and required by the code.
  
  Two boundaries make the rule safe. A value the manifest already carries is never re-detected — establishing a fact fills a gap and never corrects a record, or a replay would quietly drift from what the earlier run did. And only facts about the repository are established, never facts about the machine: `nodeMajor` and `pnpmVersion` describe wherever the command happens to be running, and re-detecting them would rewrite files nobody asked to change.
  
  A fact is also only what the repository actually shows. Where the detector finds nothing, the replay stops and names the variable rather than borrowing the default `init` uses — in `init` that default is offered to the owner as they agree to materialise, and in a replay the same value would be a decision taken for them in silence.
  
  The same default was reaching `doctor` from the other side. For a manifest that never recorded the directory, the composition marker's location fell back to `architecture/composition`, so a repository keeping its models anywhere else was told that part of its discovery was not filled — an `absent` without complete scope evidence, in the release that says it no longer reports one. The marker's location is now established from the repository when the manifest did not decide it, and what the manifest did decide still wins.

- [#20](https://github.com/E1i/mikoshi-construct/pull/20) [`2006455`](https://github.com/E1i/mikoshi-construct/commit/2006455f65c0765c119673aeacbf7aad30480b7a) Thanks [@E1i](https://github.com/E1i)! - The contract for a future `construct sync`, defined and tested before any command exists. `init` skips every file that already exists, so a repository materialized by an older version never receives a changed template; sync is the operation that closes that, and this is the part of it that decides what the word "changed" means.
  
  Classification compares only what the construct owns, chosen by the target's strategy: the whole file where it writes one, the construct block with the discovery marker bodies excluded where it edits a block — excluded because the template produces a placeholder and not a body, never because of who authored it — and per key where it merges JSON. Seven classes cover the cross product of recorded, present and produced without a gap: `add`, `update`, `keep`, `conflict`, `removed`, `orphaned` and `foreign`. Where all three exist the comparison runs in a fixed order, and the order is the contract: a file that already equals what the templates produce is `keep` whatever hand made it so, so an owner who applied a change by hand is never handed a conflict with nothing left to resolve.
  
  Two limits are recorded rather than worked around. A three-way comparison for `package.json` is not reconstructible from any manifest written before sync existed — the manifest stores a hash of the merged result and never stored which keys were the construct's — so merged files are reported per key and never written, and writability is derived from the strategy so a writer reading only the class cannot get that wrong. And editing `construct.json` by hand destroys evidence of intent: a file deleted from the tree and struck from the record reads afterwards as one the construct never wrote, which decision 0010 states along with the fact that the system recovers from it in a single cycle.

- [#29](https://github.com/E1i/mikoshi-construct/pull/29) [`97af45a`](https://github.com/E1i/mikoshi-construct/commit/97af45a491b8bc7db7fd2da9cbb109107e44f01f) Thanks [@E1i](https://github.com/E1i)! - `sync` establishes which template variant produced a block before it will write one, and refuses when it cannot.
  
  A file edited by block has two possible sources: the form the construct writes when it creates the file, whose block holds the whole document, and the form it writes into a file that already existed, whose block holds one section of somebody else's. The question of which one applies is really the question of how much of that file is the construct's, and there are three sources of evidence for it. The variant `init` used, recorded in the manifest as it runs, which is exact and only helps repositories materialized from now on. Reconstruction — rendering both variants with the recorded variables and matching the recorded hash — which proves rather than guesses, and rarely matches once the templates have moved on. And the shape of the file, which is good evidence and fails silently, so it may inform what is displayed and never authorise a write.
  
  Where the variant is recorded, the record is taken; where it is provable, it is proved; where it is neither, it is `unknown`, and an unknown path is written in no mode. The report keeps `unknown` apart from `conflict` and says why, because "we cannot tell which variant made this" and "you changed this" lead to different actions, and merged into one line the second reading tells an owner they broke something they never touched.
  
  On a repository materialized before this change the variant is unknown for every block target, so `sync --apply` leaves them alone — the first live run is safe by construction rather than by care.

- [#24](https://github.com/E1i/mikoshi-construct/pull/24) [`64705a3`](https://github.com/E1i/mikoshi-construct/commit/64705a33e85c73f3b4abbe7c14ed42c8d0a5cd16) Thanks [@E1i](https://github.com/E1i)! - The replay engine for `construct sync`: given a repository and its manifest, it renders the preset's current groups through the same materializer `init` uses and classifies every path against what is recorded and what is present. It writes nothing. Replaying with a second, parallel renderer would have drifted from the first one invisibly, because both would have been ours.
  
  It renders with the variables the manifest recorded, substituting exactly one: `constructVersion` comes from the running CLI, because a replay that stamped files with the version being replaced would write the old number into the very field the version gap is read from. Everything else stays as recorded — re-detecting the environment would rewrite files like `.nvmrc` that nobody asked to change. A variable the manifest does not carry stops the replay naming every missing one and how to supply it, so a repository materialized by an older version is never left permanently unsyncable.
  
  This repository's own `construct.json`, exactly as construct 0.1.0 wrote it, is frozen as a fixture — a real record from a real older version rather than a constructed one.
  
  Alongside it, a ladder correction the first `high` run after the previous change exposed: a design step that *completed* was recorded nowhere, so a run's attempts list and its token accounting disagreed about how many agents had worked. A completed design is now an attempt like any other.

- [#26](https://github.com/E1i/mikoshi-construct/pull/26) [`a319362`](https://github.com/E1i/mikoshi-construct/commit/a319362da14859a23ad4ef5d546403ab702c5938) Thanks [@E1i](https://github.com/E1i)! - `construct sync` arrives in its reporting form: it classifies every path of a materialized repository against today's templates and prints what it found. It writes nothing — the writer is a separate change, so a person can see what would happen before anything happens.
  
  Each class is printed beside what it means, because the words are borrowed from merge tooling and read as alarm without them. Nine `conflict` entries on a mature repository are not nine problems; they are nine files the owner owns, which the report now says on the same line. Classes with no paths are left out entirely rather than printed as zeroes, so an empty class is never read as a finding. Where an append-block target would be written, the report states that the block is replaced whole and that edits between the delimiters do not survive while discovery bodies are carried over — printed from the classification itself rather than restated, so the two cannot drift apart.
  
  The report opens with the version that materialized the repository against the version reading it, and closes on what would happen. Exit code 0 when there is nothing to add or update, and a distinct code when there is; conflicts, removals and orphans never change the code by themselves, because they are not work the tool can do.

- [#27](https://github.com/E1i/mikoshi-construct/pull/27) [`b57c241`](https://github.com/E1i/mikoshi-construct/commit/b57c2411ebd2e8a380c89f5b2e3b079af203a31f) Thanks [@E1i](https://github.com/E1i)! - `construct sync --apply` writes. It writes the paths the construct can prove it owns — `add` and `update` where the strategy is `create` or `append-block` — and nothing else: no conflict, no removed path put back, no file the construct never wrote adopted, no merged `package.json`, and no deletion. There is no flag that overrides that, and none will be added.
  
  A block target is spliced rather than replaced: the produced text between `construct:begin` and `construct:end` goes in between the markers the file already carries, every byte outside them stays where it was, and a filled `construct:discover` body is carried over. The writer deliberately does not reuse the append path `init` takes on first contact, whose second-`H1` demotion would make what is written differ from what was compared — and an apply that writes something other than what it compared reports the same path as pending forever. An apply followed by a plain sync now reports nothing to add or update, which is the proof the writer is honest.
  
  Each written path is recorded in `construct.json` under `sync` with the sha of its owned view, when the run happened, the version that materialized the repository and the version that wrote. The branch `init` wrote is untouched, the record accumulates across runs, and when nothing was written the manifest is not touched at all. `doctor` still reports a rewritten file as modified: the baseline is what `init` recorded, and correcting it would erase the evidence of what `init` did.
  
  Exit code 0 when every pending path was written, 2 when one was refused because no record can prove the construct owns it — every merge-json target, whose keys are reported for you to carry across — and 1 without a `construct.json`.
  
  The `CLAUDE.md` a new repository receives no longer opens with an `H1`: it opens with `@AGENTS.md`, which imports the document that carries the project's title. Inside an existing repository's `CLAUDE.md` that heading was a second title, and sync writes the same block into both kinds of file.

### Patch Changes

- [#25](https://github.com/E1i/mikoshi-construct/pull/25) [`f44d7ed`](https://github.com/E1i/mikoshi-construct/commit/f44d7ed3e269566523d9811d83075b5dc9ede16d) Thanks [@E1i](https://github.com/E1i)! - Ownership of an append-block target is declared by its delimiters rather than inferred from a recorded hash. Replaying a manifest written by `init` classified `AGENTS.md` and `CLAUDE.md` as `conflict` — the two files carrying the construct's own markers — because the ordered comparison asked a recorded whole-file sha whether anything in the file had changed, and discovery filling the markers, which the construct asks the owner to do, made that answer false forever. `construct:begin` and `construct:end` are ownership stated outright in a file the owner reads and can delete, so for those targets the comparison now asks only whether the owned view is what the templates produce: equal is `keep`, different is `update`. A recorded file the owner stripped the delimiters from is `conflict` and never has the block put back.
  
  `merge-json` is unchanged and still never written: `package.json` carries no mark of which keys are the construct's, so there is no declaration to outrank the record. A classification for a block that will be written now carries that the block is replaced whole and that edits inside the delimiters do not survive while discovery bodies are carried over, so a report and a writer state it from one source.

- [#22](https://github.com/E1i/mikoshi-construct/pull/22) [`b14300b`](https://github.com/E1i/mikoshi-construct/commit/b14300bd3a4dfbe472334ac2d149fc56b407ab02) Thanks [@E1i](https://github.com/E1i)! - The ladder's design step lived outside the rung loop, and that single placement made three claims false at once: a run reported an effort class whose defining step had not executed, the attempts list claimed to record every failed attempt and did not, and the status reported success for a run that had silently degraded. Observed for real — an architect failed schema validation, returned nothing, and the run went on without a design, reported `high, done, one attempt, passed`, and delivered work in which a prohibition was left living in the prose of a decision record instead of in the code. A person found that by hand; nothing in the harness could have.
  
  Design is now part of a run. Its outcome is recorded in `attempts` like any other, a failed architect blocks a `high` run rather than letting it continue undesigned — `high` is chosen exactly where a green harness proves the least — a `low` or `medium` run may continue but ends as `degraded` rather than as a plain success, and the effort a run reports describes what actually executed, so a run without a design does not call itself `high`.
  
  Decision 0011 records that a retry limit of zero was and remains right: it saved a second full agent entry of about 2.6M tokens and worked as designed. What was missing was a described path for the case it creates, and an unspecified fallback is how a correct decision produces an incorrect run.
  
  The ledger reader also gains a stated invariant it previously held by accident: a line whose status or attempt outcome this version has never heard of reads as valid rather than malformed, because a newer CLI writes the ledger an older one reads.

- [#40](https://github.com/E1i/mikoshi-construct/pull/40) [`649cf1a`](https://github.com/E1i/mikoshi-construct/commit/649cf1a7aa3674c78dc1edd8db4a10b6b47d80a0) Thanks [@E1i](https://github.com/E1i)! - **Three corrections to the documentation, all of the same class.**
  
  The guide claimed a generated repository gets `architecture/decisions/`; it now does, because the
  directory ships. A page teaching the enforcement levels counted four of them above a table of five.
  And the sentence that four repositories were ones *this tool did not build* was false — all four were
  materialized by earlier versions of this same tool, by one author, in a similar style. The section
  whose subject is the difference between *verified* and *not observed* now names its own bias first,
  in the guide and in the release note.
  
  One more of the same kind, found on a third reading: the note quoted a retry's cost as a measured
  figure, where decision 0008 records it as the difference between two different runs — an estimate of
  order. It now says so.

- [#40](https://github.com/E1i/mikoshi-construct/pull/40) [`6ca56c6`](https://github.com/E1i/mikoshi-construct/commit/6ca56c6cd7beceff956e687e3e324f2e08b6e63d) Thanks [@E1i](https://github.com/E1i)! - **The documentation has a home: [e1i.github.io/mikoshi-construct](https://e1i.github.io/mikoshi-construct/).**
  
  A VitePress site built from `docs/`, deployed to GitHub Pages on every push that touches it, and
  named as the package `homepage` so npm links to it rather than to a README anchor. Five guide pages:
  getting started (empty directory and existing repository, with the rules for what is never
  overwritten), the development cycle end to end, the reasoning budget with the measured costs, the
  upgrade loop, and what the tool refuses to claim — the three states, the enforcement levels, and the
  difference between *verified* and *not observed*.
  
  The upgrade loop moved out of the CLI reference into its own page, so the reference stays a reference
  and the procedure has one home. The README now links the site and says v0.3 instead of v0.1.
  
  One guard moved with it. The privacy scanner reads the documentation source and skips what a
  documentation build produced from it, asserted by name rather than by ignoring the directory
  silently — and on its first run it caught a home-directory path in the getting-started page.
  
  The site is built with VitePress 2 alpha rather than the 1.x line, because 1.x depends on a vite
  release covered by GHSA-fx2h-pf6j-xcff, which this repository's dependency audit blocks at high
  severity. The alpha depends on the same vite major the repository already has, so there is one vite
  in the tree, no advisory, and no trust-policy exemption. It is a development dependency that produces
  static HTML and ships in no package.

- [#31](https://github.com/E1i/mikoshi-construct/pull/31) [`9c00c33`](https://github.com/E1i/mikoshi-construct/commit/9c00c33f633b09588a04fa26b215285ad43ee16f) Thanks [@E1i](https://github.com/E1i)! - The first time the tool wrote into a repository on its own judgement rather than on an explicit `init`, recorded here as the manifest's `sync` branch.
  
  The run had exactly one effect, and the interesting part is why. Both files carrying a construct block reported `unknown` — nothing records which template variant wrote them and no rendering matches the recorded hash — so sync refused to touch them, which is the rule working rather than a limitation being hit. What it did write was `tsconfig.base.json`: the file deleted from this repository by hand months of commits ago, whose removal was also struck from the manifest, so that the intent behind it no longer existed anywhere to be respected.
  
  Deleting it again closes the loop. Because the write is now recorded, the same path reads as `removed` from here on and is never offered again. The record the manual edit destroyed has been rebuilt — not the file, but the knowledge that the construct wrote it and the owner took it out.

- [#33](https://github.com/E1i/mikoshi-construct/pull/33) [`90bc936`](https://github.com/E1i/mikoshi-construct/commit/90bc936a8f139cf84f42c86933b57c3681b31402) Thanks [@E1i](https://github.com/E1i)! - Four manifests written by 0.1.0 and 0.1.1 are frozen as fixtures, with every name replaced. They are valuable precisely because they cannot be generated: today's code produces today's manifests, so every fixture written here tests the replay against records the current templates could have made. In the wild there are records made by versions that no longer exist, and now four of them are covered.
  
  What is kept is the shape — how many packages a workspace has, what roles they play, which may import which, which variables the version of the day recorded. What is replaced is every project name, scope and package name, because a repository's own names belong to its owner and one of these carried the names of other people's companies. The recorded hashes are meaningless after that replacement and the accompanying note says so, so that nobody later compares a rendering against them or edits the fixtures toward more realism.
  
  The privacy guard, which scanned `templates/`, `docs/` and `README.md`, now scans `tests/fixtures/` too — the place these records live and the one place it was not looking. A test asserts that every scope inside a frozen manifest belongs to that fixture's own invented project, so a name from somewhere else fails the suite rather than waiting to be noticed in review.

- [#39](https://github.com/E1i/mikoshi-construct/pull/39) [`ae89c3a`](https://github.com/E1i/mikoshi-construct/commit/ae89c3aef20c780353858120a8440da26cdf9f83) Thanks [@E1i](https://github.com/E1i)! - **The glossary explains every in-universe word the tool actually prints.**
  
  `sync` shipped its vocabulary — braindance, engram, relic write, blackwall — and the README table
  that exists to translate the lore did not mention any of it; `glitch` and `flatlined` had never been
  there either. All seven are now in the table, and a test reads the glossary section and requires it
  to name every word in the vocabulary the lore guard already polices. The list has one home, shared by
  both tests, so adding a word to the output makes the README fail until it is explained.

- [#38](https://github.com/E1i/mikoshi-construct/pull/38) [`ffeb069`](https://github.com/E1i/mikoshi-construct/commit/ffeb0697ebcb6c433d0f87a1e1568f4bf8da6c0a) Thanks [@E1i](https://github.com/E1i)! - **ENGRAM EXTENDED — a second `construct init` adds to the record instead of replacing it.**
  
  `files` is the protocol of what the construct has ever written into a repository, not a snapshot of
  the last run. A re-init rewrote it with only the paths that run wrote, so every path the first run
  wrote and this one skipped as "exists, review manually" silently left the record. Measured on a
  scratch tree: a manifest carrying 43 paths, re-inited, then read by `construct sync` as 4 `keep` and
  39 `conflict`, with nothing in the tree changed. Discovery provenance went the same way — the branch
  that exists to evidence authorship was replaced with ten `unknown` markers.
  
  `buildManifest` now takes `previous` as a required input. When there is one, `files` and `variants`
  merge, `construct`, `createdAt`, the discovery record and the sync record stay the earlier run's
  values, and only this run's configuration — preset, AI target, review, harness, contracts, vars —
  comes from this run, because a second `init` is how a Cursor target or code review gets added.
  
  **Both replacements are audible.** A re-init prints how many records it carried over and how many it
  added, and names every variable whose value changed with both values, because `vars` is the one
  place the merge still replaces a decision: a different `--name` moves `projectName` while the
  recorded hashes were taken with the old one. Nothing is forbidden; it is said out loud.
  
  Recorded as decision 0013, which supersedes the one sentence in 0006 that read the other way, and
  states the consequence that arrives later: after a preset change the paths the old preset wrote stay
  in `files` and read as `orphaned`, and cleaning them out would be this defect returning under a
  tidier name.

- [#32](https://github.com/E1i/mikoshi-construct/pull/32) [`3ad92ca`](https://github.com/E1i/mikoshi-construct/commit/3ad92ca05d8266df1e75b9fdb58a71fb1738d061) Thanks [@E1i](https://github.com/E1i)! - The syntax-policy test ships only where the construct wrote `eslint.config.mjs`. It had been moved into
  each preset's `baseline` so it would reach a repository that already has code, but `eslint.config.mjs`
  is `baseline` too and an existing one is never overwritten — so the test landed next to an owner's
  configuration and asserted the construct's selectors against it. Against a repository whose policy is
  deliberately narrower, every form the narrowing skips reads as a restriction that failed to fire, and
  `pnpm run quality` fails immediately after `init` on a configuration that is not wrong. No guard fixes
  that: a test deriving its expectations from the resolved selectors asserts that what is declared is
  declared, and a present-but-narrower policy is neither present-as-shipped nor absent.
  
  The test returns to `sample` in node-backend, node-frontend and monorepo, unchanged in strength, and
  node-backend's `sample` group entry is restored. A repository that keeps its own lint configuration
  hears the same thing from `doctor`, which reports `lint-policy absent` with its evidence — the one
  place that can tell the two situations apart — and `docs/cli.md` now says so and how an owner adopts
  the policy deliberately.

- [#36](https://github.com/E1i/mikoshi-construct/pull/36) [`bb85cb3`](https://github.com/E1i/mikoshi-construct/commit/bb85cb349c930e85ce9cdff3c6908339d29e3251) Thanks [@E1i](https://github.com/E1i)! - **The 0.3.0 release note is written from measurements rather than intentions.**
  
  What the first `sync` writes on a repository materialized by 0.1.x is counted across four
  repositories built before it existed, not estimated: 118 paths `keep`, 24 `update`, 54 `conflict`,
  and two offered for writing. The note names the sample's bias before its result — one author, earlier
  versions of this same tool, a similar build style — because the independence it provides is narrow
  and specific. All seven classes occurred there, `orphaned` and `removed` included —
  the two that most resembled cells invented to complete a grid.
  
  Two passages are new beside the numbers. A check that was true, ran in CI and was still beside the
  point, because a correct assertion aimed at someone else's configuration is a defect of aim rather
  than of strength. And the difference between *verified* and *not observed*: the four repositories
  ground what the note says about `sync` and cover nothing about a repository that keeps its
  composition models off the default path — there a synthetic case holds, and the note says so.

- [#35](https://github.com/E1i/mikoshi-construct/pull/35) [`7f34e2b`](https://github.com/E1i/mikoshi-construct/commit/7f34e2b80c4fd34604edd4c3fa79ec47ef2cbfd0) Thanks [@E1i](https://github.com/E1i)! - **BRAINDANCE — the sync line gets its names, and the README gets its commands.**
  
  `sync` and `--apply` are named in the README beside the commands that were already there, and a
  test reads that table and requires every entry to be a command the CLI actually defines.
  
  The report's vocabulary is settled: the replay is a braindance, a write is a relic write, a block
  whose template variant cannot be established is beyond the blackwall, and the version gap reads as
  an engram cut by one version and replayed by another. Lore only — no classification, threshold or
  exit code moves with it, `--plain` output is unchanged, and the guard for that now checks the plain
  table against an in-universe vocabulary instead of filtering out the strings where a leak would sit.

- [#37](https://github.com/E1i/mikoshi-construct/pull/37) [`6b6a80b`](https://github.com/E1i/mikoshi-construct/commit/6b6a80ba307f5e211e966ab67556641d5d46549f) Thanks [@E1i](https://github.com/E1i)! - **The docs say what a repository does when a new version lands.**
  
  `sync` is one step of four, and the CLI reference now writes the loop out: report, `--apply`, your
  own harness, `doctor`. Each step answers a different question, and the note that matters most is
  that `sync` does not answer the harness's — the construct writes what it can prove it owns, which
  is not a claim that your project still builds.
  
  Also stated: a sync never erases discovery, because the filled body of every marker is carried
  across a block replacement; what the report leaves for the owner, class by class; that the version
  in `construct.json` is frozen by design and the pending count is the number that moves; and that
  re-running `init` is not an upgrade path. That last one is measured, not asserted — a tree whose
  manifest carried 43 paths was re-`init`ed, and the next `sync` read 4 `keep` and 39 `conflict`,
  because `init` rewrites the record with only the files that run wrote.

## 0.2.0

### Minor Changes

- [#13](https://github.com/E1i/mikoshi-construct/pull/13) [`04ba003`](https://github.com/E1i/mikoshi-construct/commit/04ba0036c3f556d25ae36b3e4c78ce2720b44bdb) Thanks [@E1i](https://github.com/E1i)! - `construct cost` stops reporting two different facts as one. A missing project directory meant both "this runtime does not expose per-run usage" and "nothing has been run here yet", and the command printed the more damning reading of the two — so a Cursor user was told nothing was recorded when the truth was that their runtime never records it. Behind a `CostSource` interface, the command now resolves the runtime it is actually running under and answers `ok`, `empty`, `unsupported`, `mismatch` or `unknown`, each with its own exit code and its own line. `--json` is an object carrying the status, the runtime and the project key that was looked up. A key that misses because the repository was reached through a worktree, a symlink or another path is named as such instead of being reported as absence, and where the evidence does not settle it the answer is `unknown` rather than a guess.

- [#17](https://github.com/E1i/mikoshi-construct/pull/17) [`7e8ca83`](https://github.com/E1i/mikoshi-construct/commit/7e8ca83275f67c6362abc1d61d2cb7fffea0f561) Thanks [@E1i](https://github.com/E1i)! - Discovery fills the markers in `AGENTS.md` and the invariants table, and once filled nothing distinguished what the tool wrote from what the repository's owner stands behind. `construct.json` now records it: `discovery.baseSha`, `discovery.filledAt`, and per marker the file it lives in, who authored it and the sha256 of the body discovery wrote. The marker itself stays a document a person reads — provenance in the prose would spoil the document and would put the record in the one place most likely to be edited.
  
  Authorship by the owner is never declared, only derived: a marker whose body no longer matches its recorded sha reads as theirs, with no command to run and nothing written back. Editing it by hand is the only evidence needed. `doctor` names the markers that still read back, word for word, what the tool wrote — the places where the repository is quoting the construct at itself — and reports it without making it a gate or changing an exit code.
  
  `construct.json` also carries an integer `manifestVersion`, separate from `construct`, which is the CLI version; conflating a schema version with a product version is what makes a later migration undecidable. Manifests written by 0.1.x are normalised on read by a pure upgrade, so a repository initialised before this change gets a report instead of a crash. Their markers read as `unknown`, never as the construct's: a legacy manifest carries no provenance, and claiming otherwise would have this feature produce exactly the lie it exists to prevent.

- [#12](https://github.com/E1i/mikoshi-construct/pull/12) [`39f8569`](https://github.com/E1i/mikoshi-construct/commit/39f8569b1e3ed1c85853e71358b253a9401f90b0) Thanks [@E1i](https://github.com/E1i)! - cli: `doctor` reports an enforcement level instead of matching substrings. Five checks — `lint-policy`, `construct-tests`, `ci`, `hook`, `red-gate` — each return `{id, level, state, evidence}`, with `level` from `L0` (text, or a command nobody is obliged to run) to `L3` (CI), `state` one of `present`, `absent` or `unknown`, and evidence naming the file or key that was read. The report ends with one line naming the weakest link: the lowest level among the gates the repository claims. `--json` gains `warnings`, `checks` and `weakestLink` after the fields it already emitted, which keep their names and meaning; the exit code is unchanged, so a low level is information, not a failure.
  
  `doctor` executes nothing from the repository it inspects — no child process, no dynamic import of a path inside it, no `require` into its `node_modules`, no call into its ESLint or Vitest APIs — because it is run through `npx` in a clone nobody has decided to trust yet, and a flat ESLint config is a module. The lint policy forbids those forms under `src/**` and `tests/dependency-policy.test.ts` lints one sample per form. Because branch protection lives in the GitHub API and not in a file, `doctor` never claims `L4`, `ci` is never `absent`, and the red gate is always `unknown` and says so.

- [#15](https://github.com/E1i/mikoshi-construct/pull/15) [`26e449a`](https://github.com/E1i/mikoshi-construct/commit/26e449acbff3825c48e54a289356b7e7a06412b9) Thanks [@E1i](https://github.com/E1i)! - `construct cost` now reads the run ledger and reconciles it against what the runtime exposes, joining on the runtime's own run identifier — which the `/implement` skill step records from here on. Both directions are reported and counted: an entry whose run has no session, and a session with no entry. Neither is an error; they are the two ways a record and a reality drift apart, and seeing the drift is the point. Pairing entries to sessions by time is deliberately not done — that is a guess presented as a finding. Entries written before the key existed are counted as unjoinable, lines that do not parse or lack a declared field are reported with their line number and the exact field path, and a token value of `unknown` is never read as zero, because zero is a number and it would be a lie.
  
  The ledger's declared schema is what the writer can actually produce and no more: the workflow returns aggregate accounting for a run, never a row per agent, so no per-agent field is declared. Declaring a field nobody writes is the same defect as claiming an enforcement nobody performs. `docs/cli.md` says plainly that the ledger is written by a step of a skill and is therefore L0 — a record nobody is obliged to keep.

- [#19](https://github.com/E1i/mikoshi-construct/pull/19) [`7664355`](https://github.com/E1i/mikoshi-construct/commit/76643555bd73f9da960bf4dbabd6208ba48af2b2) Thanks [@E1i](https://github.com/E1i)! - The lint policy checks never reached a real repository. They lived in each preset's `sample` group, and a sample is materialized only into an empty directory — so `init` against a repository that already has code, the case this tool exists for, wrote the policy and skipped the test that proves it fires. `doctor` had been reporting `lint-policy L0 absent` and was right. The tests now ship in `baseline`, and arrive whether the directory is empty or not.
  
  `node-frontend` declared three restrictions and shipped no test that any of them fires; it now has one, and the restrictions cover their class — a computed member reaches the same method, and binding an element's `classList` or `style` to a local name steps around a selector matched on the member expression. Reverting any of them to its narrow form fails the new tests.
  
  `node-library` is deliberately untouched and still reports `lint-policy L0 absent`. It declares no syntax policy — its groups are the base and the harness, and the harness config carries no restriction of the construct's — so `absent` is a true reading rather than a missing file, and `docs/cli.md` now says so where the check is documented. Manufacturing a policy so that a report turns green is the defect this tool exists to find.

- [#7](https://github.com/E1i/mikoshi-construct/pull/7) [`f22bcdf`](https://github.com/E1i/mikoshi-construct/commit/f22bcdf9e2b2e62a7c68978c4e8bcc479e5bb218) Thanks [@E1i](https://github.com/E1i)! - The policies the presets ship were shape matches on one spelling each, and the same operation written another way walked past: `await import('@scope/shared')`, `const { env } = process`, `globalThis.process.env`, `const { body } = req`, and — worst of the set — ``sql.raw`select 1` ``, the tagged form that `NO_RAW_SQL`'s own message tells you to use. Each restriction in the monorepo and node-backend presets now covers its class, including binding `process` or `req` to a local name, while keeping every role's exemptions exactly as they were.
  
  The durable half is the test. `syntax-policy.test.ts` compared resolved selector strings against the same strings restated in the test — proof that a restriction is attached, never that it fires. Both presets now lint real source per role from a single per-role table: one sample per restricted form expecting a report, each role's exempt forms expecting none.
  
  Named limit: in the monorepo, a package that binds `process` to a local name and reads `.env` off it is still not reported. That restriction is env-specific by design, and widening it would change what the rule means rather than what it catches.

### Patch Changes

- [#8](https://github.com/E1i/mikoshi-construct/pull/8) [`7f07169`](https://github.com/E1i/mikoshi-construct/commit/7f07169ece912615b56fb8efe6ab8a9a915ffcbf) Thanks [@E1i](https://github.com/E1i)! - Acceptance now runs the artifact that actually ships. Each leg installs the packed tarball into a directory outside the repository and invokes the installed `construct` binary for `init` and `doctor`, instead of `node dist/cli.js` out of the working tree. That is what publishing exercises: externals tsup leaves out must resolve from the installed package's own dependencies, `files` must carry `templates/` or the first template read fails, and `bin` must point at the built entry — running from the workspace proves none of the three, which is why nine legs went red at once. A drift guard asserts no bare import under `src/` resolves to a devDependency; it is green today and stays that way on purpose.

- [#18](https://github.com/E1i/mikoshi-construct/pull/18) [`045efca`](https://github.com/E1i/mikoshi-construct/commit/045efca3f098aa81080870eb4eb619f980a5a3af) Thanks [@E1i](https://github.com/E1i)! - The README's cost paragraph is rewritten from thirteen measured runs instead of three, and it now says something different. The old text argued that the reasoning class predicts the price. It does not: nine `medium` runs spanned 847k to 5.9M. What the measurements show is that almost the entire cost of a run is each agent's entry into the repository — a fresh exploration, paid in full before anything is produced and paid again by every agent that starts. Two `low` runs cost 557k and 740k with two agents each; two `high` runs cost 14.19M and 14.14M with three. The class decides how deep an entry goes; the ladder decides how many entries there are, which is the claim the tool should be making.

- [#10](https://github.com/E1i/mikoshi-construct/pull/10) [`728efc7`](https://github.com/E1i/mikoshi-construct/commit/728efc738224845fc10bcb219ee05d7d01b109e2) Thanks [@E1i](https://github.com/E1i)! - Six fixtures for `doctor` under `tests/fixtures/doctor/`, written before the checks that will read them and asserting the wrong answer on purpose. Five repositories are objectively broken — an eslint config that never loads the construct policy, construct tests outside the runner's globs, a quality script that is red on a clean checkout, a quality script no workflow runs, a command with no hook to run it — and today `doctor` calls all five healthy. Each test says so in its title. A fixture written after the check can only confirm what the check already does; a fixture written first has to reproduce the lie. The expectations sit in one table keyed by the fixture directory, and a cross-check fails when a fixture has no row or a row has no fixture, so a check can never arrive without something that proves it can fail.

- [#14](https://github.com/E1i/mikoshi-construct/pull/14) [`21b65d3`](https://github.com/E1i/mikoshi-construct/commit/21b65d3fe277e1b5ec9f52bbb43b04ecf52b177d) Thanks [@E1i](https://github.com/E1i)! - The ladder's output contract was declared twice and the duplicate was the weaker of the two. The runtime validates against a schema; the agent files then restated the same contract in prose and closed with a fenced JSON example, which reads to an agent as "format your answer as text that looks like this" — the likely cause of a run where five answers in a row came back invalid, and a contradiction of decision 0005, which this repository had already taken. The fenced block is gone from the agent files here and in the templates; what remains is a list of the fields and what each one means. Alongside it: a schema-rejected response now retries with the validator's complaint in the prompt instead of a bare "the previous attempt failed", the retry limit is a parameter rather than a literal, and every failed attempt is recorded with a reason that tells a bad shape apart from a red harness and from a blocked report.

- [#5](https://github.com/E1i/mikoshi-construct/pull/5) [`3116836`](https://github.com/E1i/mikoshi-construct/commit/31168365a71acf32a70c7f3c2d32711540f00927) Thanks [@E1i](https://github.com/E1i)! - Black ICE on the package boundary: `pnpm run quality` now runs a privacy guard over `templates/`, `docs/` and `README.md`. Domains are permitted by an explicit allowlist — a denylist in a public repository names the very thing it hides — and any host in a URL or an email address is checked whatever its top-level domain. Home directory paths (`/Users/<name>`, `/home/<name>`, `~/<name>`) are refused outright, one such path is gone from the sample transcript in `docs/cli.md`, and a test asserts the published file list carries nothing under `.construct/`, `findings/` or `runs/`.

- [#16](https://github.com/E1i/mikoshi-construct/pull/16) [`27cf209`](https://github.com/E1i/mikoshi-construct/commit/27cf209d6d4cd6331b6a3faaac67e7ccc2712fd5) Thanks [@E1i](https://github.com/E1i)! - The ladder no longer re-asks an agent whose response the schema rejected: `retryLimit` defaults to `0`, and the run stops with the validator's error where a person can read it. This default has a measured price tag, which is rarer than it should be.
  
  A run was killed when the architect failed structured-output validation five times and hit the runtime's own retry cap. Re-running the identical task after the duplicated output contract was removed produced a valid spec on the first attempt. Comparing the two: the failed architect cost 3,658,281 billable tokens for nothing, the successful one 3,118,576 — so the four extra schema attempts inside a single call were worth about 135k each, not the millions they looked like. That cap belongs to the runtime and is not ours to set.
  
  What *is* ours is `retryLimit`, and it counts whole additional agent calls. Each one repeats the agent's exploration of the repository from scratch — about three million tokens for an architect — and it cannot fix a contradiction in the brief, because the agent is not allowed to change the brief. The first attempt already carries the runtime's five internal tries; a second full call buys a rerun of the same misunderstanding at a thousand times the price of one schema retry. Stopping and showing a human the validator's complaint costs nothing and took about a minute to act on when it happened.

- [#9](https://github.com/E1i/mikoshi-construct/pull/9) [`51921a5`](https://github.com/E1i/mikoshi-construct/commit/51921a56ed2700f928d0b8f45b50a38ef653cc5a) Thanks [@E1i](https://github.com/E1i)! - Two claims that were made but never checked are now tests. Materialization is deterministic: for every preset and every AI target, two `init` runs into empty directories with fully pinned variables produce identical file lists and identical hashes, so a future template that reaches for a `Date`, an unordered `Set` or an unsorted walk fails the gate instead of shipping. And the claim that this repository runs on its own construct is now a replay compared against the repository root, with every difference declared in `architecture/self-hosting-drift.yaml` with a reason — ten of them, measured, not assumed — failing in both directions so the list cannot rot into decoration.
  
  Deliberately not done: the replay is never compared against the sha256 map in `construct.json`. That manifest was written by 0.1.0; comparing today's templates to it compares two versions and calls the result reproducibility. Decision 0006 freezes what `init` wrote and scopes the freeze to that branch only, since provenance will write the discovery branch later. The boundary is stated in the test itself: what reproduces is materialization; discovery does not, and pretending otherwise would be the defect this work exists to catch.

- [#6](https://github.com/E1i/mikoshi-construct/pull/6) [`7cbf62d`](https://github.com/E1i/mikoshi-construct/commit/7cbf62d888f360c124accafe02a55369c09dd86d) Thanks [@E1i](https://github.com/E1i)! - The ICE was painted on, not wired: the invariant "the CLI spawns exactly one child process" was enforced by a single selector matching a static `import` of `node:child_process`, so `await import('node:child_process')` and `createRequire(target)('eslint')` walked straight through. The `spawnPolicy` block now fails the build on the whole class — any dynamic `import()` whatever its specifier, `require` calls and `require.*` access, `node:module` and `createRequire` — anywhere under `src/` except the pnpm version probe, and `tests/dependency-policy.test.ts` lints one real source sample per form instead of comparing selector strings. The invariants table now names the mechanism rather than the word `lint`.

## 0.1.3

### Patch Changes

- [#3](https://github.com/E1i/mikoshi-construct/pull/3) [`b3051b6`](https://github.com/E1i/mikoshi-construct/commit/b3051b6981139a9972b938126bcc464ce7a05b2c) Thanks [@E1i](https://github.com/E1i)! - cli: a `pnpm-workspace.yaml` or `workspaces` field counts as a monorepo only when it lists packages.
  Since pnpm 10 that file also carries settings such as `minimumReleaseAge` and `allowBuilds`, and the
  construct ships one in every preset, so a generated single-package project reported itself as a
  monorepo and a second `init` suggested the wrong preset.

## 0.1.2

### Patch Changes

- [`1cf5709`](https://github.com/E1i/mikoshi-construct/commit/1cf57095fd314087a11ec537bd4da298df09f68f) Thanks [@E1i](https://github.com/E1i)! - cli: document the commands. The README now opens with a real first run and a Usage section covering a
  new project, an existing repository, agent targets and the read-only commands; docs/cli.md is the
  full reference with every flag, worked examples and exit codes.

## 0.1.1

### Patch Changes

- [`b34f3a8`](https://github.com/E1i/mikoshi-construct/commit/b34f3a89a489764e8272e1a34d252ff36ad202f2) Thanks [@E1i](https://github.com/E1i)! - templates: gitleaks allowlists construct.json

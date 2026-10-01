# Open questions

These look like conventions but the codebase is not consistent about them. Confirm before treating
them as rules. Read this file when a task touches one of them; it is not loaded into every session.

<!-- construct:discover:open-questions -->
- **Which of the three documents that list commands is the source?** That all three state the
  command list is structural and is recorded as the hypothesis
  `the-command-list-is-stated-in-three-documents` in `construct.model.json`, which stands on a fact
  per document and is re-derived on every read. Which one the other two should point at is judgment,
  stays here, and ages: nothing re-checks this paragraph.
- **Where does evidence of enforcement capability belong?** The model records the declared
  enforcement mechanism and evidence that the mechanism exists and runs. It does not represent
  evidence that the mechanism can actually *fail* when the invariant it protects is violated.
  Harness mutation tests are evidence of enforcement capability, and PR #57 added an observed case
  of a different kind: `testsWeakened` caught erosion in a live implementation change rather than in
  a dedicated mutation fixture. A second class was observed on 2026-09-21 — tests deleted alongside
  the modules they covered, where legitimacy needed human adjudication. That occurrences of both live in
  [architecture/observations.md](observations.md) rather than in the records they bear
  on is carried by the hypothesis `occurrences-live-in-observations-not-in-the-records-they-bear-on`;
  neither is offered as a frequency. So is enforcement capability a fact about the repository, which the
  model should represent, or process evidence belonging to the corpus and the harness history?
  Do not resolve this before `doctor` consumes the model. Revisit it when `doctor` reads the model
  on a live repository and a useful diagnosis turns out to need a fact the model cannot provide.
  Until then the blind spot is represented by the absence of a question the model can answer — not
  by synthesising an `unknown` value or any equivalent derived status, which would assert that the
  question was asked and came back empty.
  **Candidate evidence, observed 2026-09-21, leaning toward "a repository fact".** On that date the
  claim `vulnerable-dependencies-are-visible` rendered `held` at **L3** while the job behind it
  carried `continue-on-error` and could not fail. That the job still cannot fail is structural and is
  carried by the hypothesis `the-dependency-audit-job-cannot-fail`; what level the claim declares
  today is in `construct.model.json` and is not restated here. What the observation showed stands: that a mechanism cannot fail is a property of a
  workflow file — a fact about the repository, checkable from the repository — which is what tilts
  this one case toward the first answer. It is one case and the question stays open. Note also where it
  surfaced: on the construct's own repository, before any other, and the second half of 0017's
  acceptance is still owed by a repository the construct never materialized. The inspection that
  found it is recorded in
  [architecture/observations.md](observations.md).
  If it resolves towards "a repository fact", it becomes a **new rule number**, never an expansion
  of [rule 8](epistemic-rules.md). The two are adjacent in meaning and must stay
  separate in identity: *a command exists → the enforcement level* is rule 8, and *the enforcement
  level → the capability demonstrated* would be the new rule. Rule 8 may later point at it with a
  "see also"; its own scope stays as written.
- **Has an interpretation been reconsidered since the tree around its facts changed?** The model has
  no way to say, and this is an absence of means rather than a suspicion about any entry. All seven
  hypotheses here hold every fact under them and each records `baseSha` `906f554`, while `HEAD` is
  four commits further on. **Facts holding is not the same as an interpretation still being apt**: a
  file can go on containing what a fact names while the reason that mattered has moved underneath it.
  The model neither asserts nor denies that today, and nothing in it is claimed to have gone stale —
  saying "may have gone stale" would be a weak claim that it has. What is `unknown` is whether a
  reconsideration is owed, which is [rule 2](epistemic-rules.md) applied to the model's
  own interpretations rather than to a repository's enforcement.

  This sits beside the enforcement-capability question above and answers something different. That
  one asks whether a declared mechanism can actually enforce the claim it names; this one asks
  whether an interpretation has been looked at again since the ground under it moved. They share a
  genre and must not be merged.

  The obstacle is what makes it a question rather than a task. Answering it means reading what
  changed under a hypothesis's facts since its `baseSha`, which means `git` — and `doctor` executes
  nothing from the repository it inspects
  ([0007](decisions/0007-doctor-executes-nothing.md)). Whether that boundary covers
  `git`, which is not the inspected repository's code but is still execution, is part of what this
  question asks. It is not resolved here and no mechanism is proposed.
- **How does a repository materialized before 0.5.0 get a model?** **Settled by practice, not by
  decision: option three shipped.** That the upgrade guide names `init` as the step that writes a
  model is carried by the hypothesis `the-upgrade-guide-names-init-as-what-writes-a-model` — the
  third option below, taken and published without this question being told. It shipped in #121 on 2026-09-21, the
  same day this marker was last revised in #92, and nothing re-read the question in between, because
  nothing re-reads it at all. What is still open is narrower and is judgment: whether an explicit
  command should exist so that acquiring a model is not a side effect of a command named for
  something else.

  `construct.model.json` is written only by `init` and is not materialized from templates, so `sync`
  never creates one. The three options as originally written: `sync` learns to write a fresh model when none exists, which puts repository knowledge
  in a command whose job is file provenance and blurs the line
  [0016](decisions/0016-the-model-is-the-source.md) draws; an explicit command, which
  keeps the two apart but adds surface for a file the tool can already write; or nothing until the
  repository's next `init`, which is the smallest change and leaves `doctor` reporting `unknown` about
  claims for as long as that takes. The third is only tolerable because a missing model is honestly
  `unknown` rather than a failure — so the projection's no-model acceptance must land before this is
  decided, not after.
  **What this now blocks, 2026-09-21.** Since discovery writes its hypotheses into
  `construct.model.json` and creates none where the file is absent, a repository that arrived at the
  current baseline through `sync` from 0.4.x has nowhere for discovery to write: it can fill every
  marker and still record nothing structural, and `doctor` can say nothing about what that repository
  takes itself to be. Self-identification is therefore unavailable to those repositories until their
  first `init`. That is what makes this question gating rather than academic for any repository in
  that state; how many are in that state is not known here and is not asserted. It is not decided here; the three options above stand as written.
- **What can record provenance for a marker whose body was written before anything recorded it?**
  `doctor` reports nine markers here as carrying no recorded provenance, and they are not to be
  backfilled. Recording a sha asserts that the body it hashes is the construct's own words, written by
  the run that recorded it. With no sha on file there is no evidence of what those bodies now are —
  the construct's text from an earlier run, or an owner's edit since — so hashing them today would
  turn *never looked* into *checked and matching*. That is [rule 2](epistemic-rules.md)
  in the direction that manufactures support, and it is the laundering
  `.claude/commands/construct-discover.md` forbids when it records provenance only for the markers a
  run filled and leaves the rest with the entry they had, applied to nine markers at once.

  So `unrecorded` is the true state here and it stays. Provenance can be recorded only by the run that
  wrote the body: the next discovery run records it for the markers it rewrites, and the rest go on
  reading `unrecorded`, truthfully.

  **What is open is the shape any answer can take, not whether to backfill.** The step that knows what
  body it wrote is a hand-written L0 step — the run sets `discovery.markers.<name>` itself, and nothing
  checks that it did so, or that the sha it wrote is of the text it actually wrote. Any command that
  records provenance after the fact is indistinguishable, at the moment it runs, from the laundering
  above: it reads a body it did not write and asserts authorship of it. So an answer cannot be a
  command the owner runs afterwards. Either the write happens inside the same act that authors the
  body, or it does not happen. That is the constraint; no design is proposed here, and nothing about
  the nine is repaired by naming it.
- **What makes a machine-readable output refuse a reader it can no longer serve, and is that the
  mechanism the two records already share?** `construct.json` declares `manifestVersion` and
  `construct.model.json` declares `modelVersion`, and each refuses a record written by a later build
  through one shared error rather than one of its own. `doctor --json` declares nothing: `src/program.ts`
  serialises `DoctorResult` as it stands, so the output carries no statement of what it is, and there
  is nothing for a reader to check or for the tool to refuse. A consumer matching a value that has
  since changed — `authorship: "unknown"`, which 0.16.1 no longer emits — receives no error; its
  branch simply stops firing.

  The two are not the same situation and the question is partly whether they can share an answer. A
  record is read by this tool, which can refuse it; an output is read by somebody else's code, which
  this tool cannot make check anything. What a version buys there is the ability to be refused *by*
  the reader, which is a different transaction from the one `RecordAheadOfReader` performs.

  **Measured before this was written: the consumer count is zero.** Nothing the construct materializes
  calls `doctor --json` — not the templates, not the workflows, not `construct-discover.md`. Every
  match outside the source is built documentation or release-note prose. **That is what makes an
  answer cheap now rather than what makes it unnecessary**: the reason to declare what an output is
  does not arrive with the first consumer, but the cost of declaring it does. Nothing is designed or
  decided here.
- **Can an owner declare a construct-owned path they do not want, and files they maintain themselves,
  so that `doctor` can tell a declared deviation from an unknown one?** `doctor` exits 1 here for two
  conditions that are legitimate and permanent. `tsconfig.base.json` is recorded in the manifest's
  `sync` branch and absent from the tree. Fifteen baseline files are modified since `init`, which is
  what a repository that edits its own construct files looks like. Neither will become green, and a
  third condition — a real one — would arrive in the same exit code and go unread. **A check that can
  never be green reports as much as one that can never fail**, and this one now carries two permanent
  reasons for a reader to stop looking. Nothing is designed here and nothing is repaired: the `sync`
  record is a record of the past.

  **What is measured about the missing path, and what is only stated.** Measured: the recorded hash
  `040735e3…` is byte-identical to `templates/harness/tsconfig.base.json`, and `git log --all --follow`
  over the path returns nothing, so git holds no evidence either way about whether the file was ever on
  disk here. Stated, not measured: the message of commit `9c00c33` says `--apply` wrote the path and
  that it was then deleted, as it had been before. The owner does not recall deleting it. Those are two
  different kinds of claim and the second is not a record of the action, only a description of one.

- **What evidence does a run leave of a path it wrote, when git never tracked that path?** The one
  above is recoverable only from prose. `sync --apply` writes a file and records its hash in
  `construct.json`; the file itself, if it is one the repository does not track, leaves no trace of
  having existed — not in the history, not in the tree once it is gone. So what a run did is
  reconstructable from the record of *what it intended to write* and from whatever a commit message
  happens to say, and those are the two things above that must be kept apart. This is named, not
  answered.
<!-- /construct:discover:open-questions -->

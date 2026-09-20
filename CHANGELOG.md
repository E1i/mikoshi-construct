# mikoshi-construct

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

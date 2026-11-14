# Releases

Every released version, generated from [CHANGELOG.md](https://github.com/E1i/mikoshi-construct/blob/main/CHANGELOG.md).
Edit the changesets, then run `pnpm release-notes:render`; the test suite fails when this page and the
changelog drift apart. A release with a hand-written note links to it rather than repeating it here.

## 0.47.0

### Minor Changes

- [#1506](https://github.com/E1i/mikoshi-construct/pull/1506) [`7dc9bd7`](https://github.com/E1i/mikoshi-construct/commit/7dc9bd7b0a17ba33b8d5f66e1fb392419efc2844) Thanks [@E1i](https://github.com/E1i)! - The witness node now records a witness that cannot fail on the base as `unfit`, not green: a witness whose run on the base finds no test, or that names a file absent on the base and outside the card's touches, creates and diff. The card stops with a proposed replacement — the test files from the card's diff, red on main. `construct intake` takes replacing an unfit witness with a red-on-main one as a refinement, not a downgrade, and reads the owner's standing general decisions in force: under one that says a witness checking paths the card itself creates is a witness of the change, such a witness is replaced without an owner wait.

- [#1526](https://github.com/E1i/mikoshi-construct/pull/1526) [`e404d78`](https://github.com/E1i/mikoshi-construct/commit/e404d78a0468c89b9f077e51795bc7eba191e03e) Thanks [@E1i](https://github.com/E1i)! - `construct run-record` records one `/implement` ladder run: where no bus is wired for the directory it appends one line to `.construct/runs.jsonl`; where one is, the published CLI writes nothing to the bus and refuses, and `construct-intake run-record` appends one `ladder.run` event, deduplicated by the record. A record that does not parse or names a field the ledger does not declare is refused with exit `2` and nothing is written. The ladder's supervisor, watch and handoff read the run from the same source, so no reader stays on a file nobody writes.

- [#1622](https://github.com/E1i/mikoshi-construct/pull/1622) [`490ab35`](https://github.com/E1i/mikoshi-construct/commit/490ab35431cac3bf956e2e5d36aa59eb51ffc03a) Thanks [@E1i](https://github.com/E1i)! - cli: the board tells a slice apart from a whole card. When intake cuts a card into slices, each slice's `card.admitted` carries `parent` (the parent's number and its share, k of n), and the board marks every slice `◧ k/n · из #N` in text, `--json` (`parent`, `mark`) and on the page, while a whole card carries no mark. The flow, the page header and `--json` (`tally`) count live cards apart from tasks, `14 карт = 6 задач`, where a task is a parent with all its slices or a whole card. Cards cut before the field get it once from their card line with `node --import tsx scripts/intake/slice-parent-backfill.ts`, which records one `slice.parents.backfilled` event and writes nothing on a second run.

- [#1612](https://github.com/E1i/mikoshi-construct/pull/1612) [`068a4ec`](https://github.com/E1i/mikoshi-construct/commit/068a4ec0e622733de69c5ef79be916791c85c5e6) Thanks [@E1i](https://github.com/E1i)! - A project `construct init` generates with the node-backend or monorepo preset installs again. Since 2026-11-12, `pnpm install` in such a project refused `encodeurl@2.0.2`, which express pulls in, as a high-risk trust downgrade under the template's `trustPolicy: no-downgrade`. The generated `pnpm-workspace.yaml` now pins `encodeurl` to 2.0.0, the last release before that downgrade, and keeps `no-downgrade` for it rather than excluding the package from the trust policy. A project generated earlier that hits the refusal can add `encodeurl: 2.0.0` under `overrides` in its own `pnpm-workspace.yaml`.

### Patch Changes

- [#1402](https://github.com/E1i/mikoshi-construct/pull/1402) [`6d9ce3d`](https://github.com/E1i/mikoshi-construct/commit/6d9ce3d2dbed1ed522bb727c310d5ab74c9d232b) Thanks [@E1i](https://github.com/E1i)! - A card that touches `src/` or `scripts/` now runs `tests/contract/accepted.test.ts`, the test that no module writes `contract/accepted.json`, among its covering tests.

- [#1595](https://github.com/E1i/mikoshi-construct/pull/1595) [`1eac77d`](https://github.com/E1i/mikoshi-construct/commit/1eac77d085381dde937c63e5b357ff72639642d6) Thanks [@E1i](https://github.com/E1i)! - cli: an answer on a card that an amend re-admitted while its pull request is still open is no longer rejected: the card goes back to review, so the review reads the head the answer pushed instead of the bus starting another answer round on the old head. A queued card with no open pull request still rejects an answer.

- [#1489](https://github.com/E1i/mikoshi-construct/pull/1489) [`01b0006`](https://github.com/E1i/mikoshi-construct/commit/01b0006c32a811310ba499b6d7dfd2b732e1d05f) Thanks [@E1i](https://github.com/E1i)! - The answer node keeps each of its duties in its own file under `scripts/nodes/answer/duties/`: choosing the source (`source.ts`), publishing a tree with no pull request and the empty or dirty round (`publishing.ts`), the owner's or the stale question and the window's shard decision (`stale-question.ts`), the outcomes it records (`outcomes.ts`), the prompt with its CI log (`prompt.ts`), reading the card tree (`tree.ts`) and running the client (`client.ts`). `answer-executor.ts` now composes those four executor duties and runs the round; `answerer.ts` runs the session and owns the window gate rule it hands to the prompt. Behaviour, events and prompts are unchanged. The `answer-duties` concept's owner exists now: a folder owner is read at its `index.ts`, and the factory's `answer-duties` overlaps fall from 42 to 1 — `liveSessionIn` stays in `answerer.ts`, where `liveness-sites.known.json` records it for the `live-session` concept.

- [#1448](https://github.com/E1i/mikoshi-construct/pull/1448) [`6a7f79a`](https://github.com/E1i/mikoshi-construct/commit/6a7f79a0bcc076f1272b9c03c6d300ccc490b889) Thanks [@E1i](https://github.com/E1i)! - The answer round of the pre-push gate (`scripts/ci/prepush.ts --round <head>`) no longer runs the full suite under the shared quality lock when its change would select one: it runs only the tests of the layers the change reaches, none when the change belongs to no layer, and its green line says the full suite is CI's. A card session's pre-push run without `--round` is unchanged.

- [#1555](https://github.com/E1i/mikoshi-construct/pull/1555) [`e1e536f`](https://github.com/E1i/mikoshi-construct/commit/e1e536fbb68e511f6711e83f91bf0c6e8a7aa3f3) Thanks [@E1i](https://github.com/E1i)! - An answer round no longer repeats on a card whose open question already had an empty round. Once a round on a `question.agent` or `question.owner` stop leaves nothing, the next answer lease is refused before any session and spends no review round, until the owner records a decision on the card, closes its wait, amends the card, or a new commit lands on its head; then the round starts on its own (law Z8). A card held this way opens one owner wait for a decision, so it shows in the inbox, and a decision on the card closes it.

- [#1454](https://github.com/E1i/mikoshi-construct/pull/1454) [`193a898`](https://github.com/E1i/mikoshi-construct/commit/193a898c057ba02accb8abfd4182021f9ba88cb1) Thanks [@E1i](https://github.com/E1i)! - Under an active window shard, the answer node no longer stops an answer whose changes outside the card's touches all stay within the card's concept: a direct importer of a touched or created file, a file under a test root, or a test-keyed record such as `scripts/ci/sandbox-failing.jsonl`. The bus commits and pushes the answer and records `scope.widened` with those paths in the same transaction as `card.answered`. A path under `.claude/`, an owner path, an R1 path, or any other file still stops the answer as before, and without a window shard nothing changes.

- [#1453](https://github.com/E1i/mikoshi-construct/pull/1453) [`d2a5e22`](https://github.com/E1i/mikoshi-construct/commit/d2a5e22f12ce6c7a9516ae2c4529dd200be72538) Thanks [@E1i](https://github.com/E1i)! - The answer node no longer dies with `EBADF` when a client run is aborted while the client is still writing. It closed its log files on the abort, and the next output the client sent was written to a closed descriptor. Output that arrives after the abort is now dropped, and the worker keeps running.

- [#1537](https://github.com/E1i/mikoshi-construct/pull/1537) [`5295338`](https://github.com/E1i/mikoshi-construct/commit/5295338b700740aec70b523902d3fa37bc6374ae) Thanks [@E1i](https://github.com/E1i)! - The window can now write a round-limit decision "at head" and leave the sha to the bus. When a decision such as `continue-fixes PR #N at head` comes in, the bus replaces `head` with the PR's observed head sha. `allow-merge --head head` works the same way. If the bus has not observed a head for the PR, the decision is refused and the owner's word stays unused. An answer to a review's findings that reports a proof for each finding is now checked against the findings it was given. If any of them is left unproved, the answer is refused and goes again.

- [#1588](https://github.com/E1i/mikoshi-construct/pull/1588) [`6a1f06c`](https://github.com/E1i/mikoshi-construct/commit/6a1f06c4ffaf6a0d00a76efede98975db5e231e4) Thanks [@E1i](https://github.com/E1i)! - Who decides a stop under a window shard now comes from one table, `STOP_KINDS` in `scripts/policy/shards.ts`: each stop kind carries a risk level, and only an R1 kind (the version pull request, the npm stage, security-invariants, `.claude/` config, owner-merges, workflows, a dropped witness) waits for the owner; every other kind, among them an outside-touches stop and a plain agent question, is the window's to close. A witness moved to another card or into the node-contract-suite is no longer read as a dropped witness, so the window closes that stop under a shard instead of refusing it as the owner's.

- [#1444](https://github.com/E1i/mikoshi-construct/pull/1444) [`ea53498`](https://github.com/E1i/mikoshi-construct/commit/ea5349883ad078b7efe75686274c22ef738304fa) Thanks [@E1i](https://github.com/E1i)! - `pnpm board` with no flag prints a short text reading of the bus — the release progress, the owner's waits, the cards by stage, the live backlog by lane and the services — instead of the HTML page, which on the stored bus was 8.7 MB against 8 KB for the text; a stopped bus prints its stop line, the snapshot age and the waits as text. The page now prints only under `--html`; `--json` and `--plan` print what they did.

- [#1481](https://github.com/E1i/mikoshi-construct/pull/1481) [`73693e3`](https://github.com/E1i/mikoshi-construct/commit/73693e36929b01cab7b6384d9ae8ebe116aa8769) Thanks [@E1i](https://github.com/E1i)! - The board page reads its style and its script from static files beside it, `scripts/cli/board-page/style.css` and `scripts/cli/board-page/script.js`, which ship with the factory build; the script gets the page's names as data when the page renders, and `board-page.ts` drops from 1940 lines to 1280.

- [#1619](https://github.com/E1i/mikoshi-construct/pull/1619) [`3277d7b`](https://github.com/E1i/mikoshi-construct/commit/3277d7b301f4aba9fdfb2387393516c3125f82ca) Thanks [@E1i](https://github.com/E1i)! - When the owner-waits or cards projection is behind its events, the board no longer hides the section. In text, `--json` and the page it shows the last reduced waits and cards, with a mark saying how many events and seconds the list is behind. A current reading shows no mark.

- [#1547](https://github.com/E1i/mikoshi-construct/pull/1547) [`1623d8f`](https://github.com/E1i/mikoshi-construct/commit/1623d8f6b41801252d36a80387dd610a40f82147) Thanks [@E1i](https://github.com/E1i)! - `construct intake --amend`, `--export` and the launch node take a card's body from its latest `card.admitted`, not from the `card_bodies` fold, which can lag behind it. An amend made right after an admit builds on the admitted text instead of reverting it, `--export` shows an admission minutes old, and a session continued after an amend starts its handoff from the amended body. A fresh launch waits for the fold of the latest admission that carries a body, so a later admission without a text no longer hides an unfolded amend.

- [#1475](https://github.com/E1i/mikoshi-construct/pull/1475) [`1e919fe`](https://github.com/E1i/mikoshi-construct/commit/1e919fe38c595d58e992be37eaf50bda417c7069) Thanks [@E1i](https://github.com/E1i)! - Bus event payloads are declared in one catalogue, `EVENT_PAYLOADS` in `scripts/core/events.ts`; `contract/factory.json` measures its writers against it and reads all 112 event types complete, `card.admitted` with the keys `appendCardEvent` adds. A lifted launch stop re-admits the card from its last admission, keeping only the keys the catalogue declares, so an admission written before the catalogue (with `textVerified` or `bodyMatchesAdmission`) is read instead of throwing.

- [#1543](https://github.com/E1i/mikoshi-construct/pull/1543) [`fc39d4c`](https://github.com/E1i/mikoshi-construct/commit/fc39d4cc0627e854b516da9582fe453811bd2f65) Thanks [@E1i](https://github.com/E1i)! - The bus is read through one port, `scripts/ports/bus-read.ts`. A reader asks it for a slice of one event type with the payload fields it needs, and a field the event's contract does not declare is refused. A projection that is behind its events reads stale, through the watermark in `scripts/core/bus-readings.ts`, instead of answering with old rows. The port writes nothing. The board page's gauges and shard decisions, and the window's equivalence ticks, now read through it. A new concept, `bus-read`, counts every other SQL read of a bus table, and the ratchet only lets that count fall. Each moved reader returns what it returned before: the shard decisions are the newest twenty with a stop, the newest first; a card whose newest heartbeat is not JSON is left off the gauges; legacy equivalence ticks still count. Two readers the card named are not moved yet. `src/commands/board/bus.ts` may import only `scripts/core/bus-readings.ts`, and core may not re-export a port. `src/commands/doctor/factory.ts` runs no SQL of its own: it reaches the bus through `factoryLiveness`, which stays outside the port (§10a), and through the decisions file. Where the port should live so that `src/` can read through it is a question for the owner.

- [#1513](https://github.com/E1i/mikoshi-construct/pull/1513) [`f46732d`](https://github.com/E1i/mikoshi-construct/commit/f46732d16468ddb98351fe0f6c826a35d7005020) Thanks [@E1i](https://github.com/E1i)! - `construct intake --admit` no longer reads a card whose header changed — `who:`, `priority:`, `release:` or any other header line beyond the card line and `touches:` — as already admitted: the change is recorded as an amend. `construct intake --move` records in `card.moved` the body sha of the latest `card.admitted` in the bus, not of the parking file, so a move right after an amend carries the amended body.

- [#1572](https://github.com/E1i/mikoshi-construct/pull/1572) [`3f34abd`](https://github.com/E1i/mikoshi-construct/commit/3f34abddda4af297e3ae0308f575fc3f7df6848a) Thanks [@E1i](https://github.com/E1i)! - An amend that widens the touches over the paths the answer node refused now lifts that stop without the owner: the next answer closes the owner wait the stop opened, so the merge node no longer parks the pull request on it. A card session that exits at the context line or a boundary while its card is held now records a `card.waiting` with reason `held` instead of standing silent. The merge node refuses a head that changes files outside the card's touches and creates (tests, generated twins and the card's changeset follow them, as at intake), waits on it and merges once an amend covers them; the Z3 × merge cell of `scripts/nodes/laws.ts` is witnessed and its gap leaves `contract/ratchet.json`.

- [#1517](https://github.com/E1i/mikoshi-construct/pull/1517) [`4525792`](https://github.com/E1i/mikoshi-construct/commit/4525792c91525b6c27fc5d24e9eb070668a1e26c) Thanks [@E1i](https://github.com/E1i)! - `task:start` reads a card's body from the latest `card.admitted` in the bus that carries it, not from the `card_bodies` projection, so a card amended moments before its start is no longer refused as edited past intake while the reducer has not folded the amend yet. A parking file that differs from the admitted body is not read.

- [#1561](https://github.com/E1i/mikoshi-construct/pull/1561) [`6ea4c7d`](https://github.com/E1i/mikoshi-construct/commit/6ea4c7d2a1909223a315d9ae405c4130ddd9f7df) Thanks [@E1i](https://github.com/E1i)! - One owner word on a card is now one act. A decision recorded with `--card #N` queues an answer task for card N after a `question.agent` stop on its pull request, as it already did after a `question.owner` stop. Before, an answer task that the stop had already spent kept the decision's continuation from being queued. Closing a card's wait with the owner's channel word `Q<N>: …` records that word as a decision bound to the card, so the same answer task is queued. A later `decisions:add --card #N` with the same words writes no second decision and queues no second task. When a card stopped on paths outside its touches gets a decision bound to it, or its wait is closed with the owner's word that no widening is needed, the launch hold is lifted and the next launch cuts the card's tree from main.

- [#1474](https://github.com/E1i/mikoshi-construct/pull/1474) [`a3f893e`](https://github.com/E1i/mikoshi-construct/commit/a3f893efd93b50abb6c6916af52b4d5b4c291f82) Thanks [@E1i](https://github.com/E1i)! - A card session now stops at the line of its card's size: `cardContextLineBySize` in `.claude/eddies.json` gives XS, S and M 150k and L 500k, and `cardContextLine` stays as the line of a session whose size is unknown. The session carries the size in `CONSTRUCT_CARD_SIZE`, an L session compacts above its line, and the board reads each card under its own line.

- [#1431](https://github.com/E1i/mikoshi-construct/pull/1431) [`9e3aaad`](https://github.com/E1i/mikoshi-construct/commit/9e3aaad957781896b473c22fc22df942acd9f4f8) Thanks [@E1i](https://github.com/E1i)! - `pnpm card:measure --before <ts> --after <ts>` reads the bus and prints, per merged card and by size, the sessions and tokens, the verdict reasons by category, the tokens by role and the mechanism noise among the changes rounds; it writes nothing. `--list <category>` prints the texts of one category.

- [#1584](https://github.com/E1i/mikoshi-construct/pull/1584) [`340a454`](https://github.com/E1i/mikoshi-construct/commit/340a4543f0c7c55834be4a460a9c72d1821c3a13) Thanks [@E1i](https://github.com/E1i)! - Every card that stands in the queue now carries a wait record built from the card section of `contract/factory.json`. The section's new `waits` table gives each kind of wait (`launch`, `depends`, `lane`, `stopped`, `owner`) the one who lifts it (bus, window or owner) and a deadline in minutes. Each record also names the event that opened the wait. A card behind another card's open pull request in its lane gets a `lane` wait. The board's ready, waiting and blocked columns and the handoff's `blocked:` line print only that record. A projection reading that is not stale names the event it was read at. The board's waits and the handoff's `blocked:` line name the event their copy was read at, or, when it is stale, the event it was reduced through.

- [#1432](https://github.com/E1i/mikoshi-construct/pull/1432) [`95ca74b`](https://github.com/E1i/mikoshi-construct/commit/95ca74b5dcad04f9fbaf1b01da72719e3eb5a055) Thanks [@E1i](https://github.com/E1i)! - CI on a commit or a pull request is read through one pure module, `src/commands/ci/state.ts`, with no `gh` import and no spawn. The board and the port `scripts/ports/ci-reading.ts`, which holds a GitHub and an in-memory adapter, both import it, and a test fails on a read outside it. A long failed-job log now keeps its later failure block when earlier error lines would have filled the prompt, and a `gh` output over a mebibyte reads whole instead of failing.

- [#1462](https://github.com/E1i/mikoshi-construct/pull/1462) [`4256160`](https://github.com/E1i/mikoshi-construct/commit/42561605d15d118e4eacbd289634efde3dd27918) Thanks [@E1i](https://github.com/E1i)! - `construct.json` gains an optional `client` branch beside `sync`: `{ id, model, roles: { launch, answer, review, window } }`, every key optional, each role naming a client id. With no branch nothing changes: the default client and `auto`, and `manifestVersion` stays 6. `sync` never writes the branch and keeps it as it read it, and a repeated `init` keeps it from the previous record. The client port looks an adapter up by id (`clientAdapterById`) and by role (`clientForRole`); an id with no adapter is a refusal that names the id and the known ones, and `clientAdapter()` with no argument still returns the default adapter for every present caller. No caller selects a client from the record yet. A branch with no usable key reads as no branch. `doctor` names, in `unknownClients` and in one line, each id the branch names that no adapter carries, beside the known ones; it does not move `ok`. An older build that reads a record with the branch reads it: run against `main`'s `src/manifest.ts`, `readManifest` returned the record at `manifestVersion` 6 with `client` carried through unchanged, because `upgradeManifest` spreads the raw record; that build's `sync` keeps the branch, and only its repeated `init` drops it.

- [#1567](https://github.com/E1i/mikoshi-construct/pull/1567) [`4564296`](https://github.com/E1i/mikoshi-construct/commit/456429604e65a226ababdb07326dd866cf3192ad) Thanks [@E1i](https://github.com/E1i)! - The module boundary check now reads the status of each side of an edge. An undecided module may import the contract of a decided module it names in `may_use`; without that entry, into an undecided module, or from a decided module into an undecided one, the edge stays a violation, and `may_use` never makes an import into another module's internals lawful. The modules that show the owner's commands — `atlas`, `board`, `project`, `intake` and `ui` — name `command-registry` in `may_use` and stay undecided. Two ledger rows, `boundary:board->command-registry` and `boundary:project->command-registry`, vanish and leave `contract/ratchet.json`; no row is added.

- [#1471](https://github.com/E1i/mikoshi-construct/pull/1471) [`a843506`](https://github.com/E1i/mikoshi-construct/commit/a8435065e93d9f56d87da002e4c807b9ba135c54) Thanks [@E1i](https://github.com/E1i)! - Each concept in `contract/factory.json` now names its owner's export in an `ownerExport` column, beside `owner`. Generation fails when a concept marked `ownerExists` has an owner file that does not export that name, so renaming the owning function no longer goes unnoticed. A concept whose owner is not built yet keeps `ownerExists: false` and `ownerExport: null`. The check stops at the export: it does not check that anything uses that export. It reads only the owner file's own statements, so a name the owner exposes only through `export * from` is not seen and reads as a mismatch.

- [#1470](https://github.com/E1i/mikoshi-construct/pull/1470) [`b4bfb0a`](https://github.com/E1i/mikoshi-construct/commit/b4bfb0a31168aebef8162ac27a9f0bd130e1ef09) Thanks [@E1i](https://github.com/E1i)! - Each concept in `contract/factory.json` now carries a `lore` column, the in-universe name it holds, or `null`. Generation fails when two concepts hold the same lore name, so one lore name can no longer cover two different things.

- [#1640](https://github.com/E1i/mikoshi-construct/pull/1640) [`5e841a6`](https://github.com/E1i/mikoshi-construct/commit/5e841a60d4269744730ef1c381ce6d51e1939f7f) Thanks [@E1i](https://github.com/E1i)! - cli: `construct-answer <Q|#card> "words"` is a bin of its own: `pnpm owner:answer` from the installed package, as `construct-intake` is to `construct intake`. It finds the bus of the repository it runs in and its owner channel, says the word and writes one `owner.answer` request. The published `construct` stays without an answer command and writes nothing into a bus.

- [#1482](https://github.com/E1i/mikoshi-construct/pull/1482) [`cd2e935`](https://github.com/E1i/mikoshi-construct/commit/cd2e935221b3a1a4ca8f72d7c2b65f4e3b42dbec) Thanks [@E1i](https://github.com/E1i)! - `pnpm decisions:add` refuses an `allow-merge` or `continue-fixes` record whose sha is not a full observed head of its pull request and names the full head, and `pnpm handoff:write` accepts `STATUS: OWNER — boundary: round-limit` under a decisions shard.

- [#1591](https://github.com/E1i/mikoshi-construct/pull/1591) [`dc6c248`](https://github.com/E1i/mikoshi-construct/commit/dc6c248f304c4f603cd3fc605ef3782656379205) Thanks [@E1i](https://github.com/E1i)! - The event catalogue, its read and write helpers, and the card waits in `scripts/core/events.ts` are now the text the recorded factory contract generates, and a test proves every versioned contract section carries a version that the compatibility gate holds.

- [#1480](https://github.com/E1i/mikoshi-construct/pull/1480) [`89e98da`](https://github.com/E1i/mikoshi-construct/commit/89e98da96fa3a93ec8e11927a6318bb369fd9d2e) Thanks [@E1i](https://github.com/E1i)! - After the six `src/program.ts` commands the contract-surface change covered, the scripts section of `contract/surface.json` now covers the 39 `package.json` scripts that take flags, and every other script in the registry. `scripts/contract/surface.ts` writes it from a static reading of each script's entry: its flags (`parseArgs` options and `--flag` literals), whether it prints a `--json` form, the exit codes it sets, and whether a strict `parseArgs` refuses an unknown flag. `tests/contract/surface-scripts.test.ts` fails on a flag, a json form, an exit code or a refusal that a script reads as and the section does not declare.

- [#1477](https://github.com/E1i/mikoshi-construct/pull/1477) [`7caa1bb`](https://github.com/E1i/mikoshi-construct/commit/7caa1bb4ef2389f78a193ac72e7501e19c2f3f04) Thanks [@E1i](https://github.com/E1i)! - `contract/surface.json` declares every command's `--json` forms, exit codes (now `atlas` and `say` too) and unknown-flag refusal, and `tests/contract/contract-surface.test.ts` fails on one it does not declare. `contract:bump` diffs the two new sections, and `cost --expect --json` now carries a top-level `schemaVersion` like every other contracted `--json` output.

- [#1637](https://github.com/E1i/mikoshi-construct/pull/1637) [`c839088`](https://github.com/E1i/mikoshi-construct/commit/c839088705456ce2fb02e9203c526ac6c8542daf) Thanks [@E1i](https://github.com/E1i)! - Adds the overlap model and the `pr_order` order of pull requests, and runs it in the bus. `scripts/core/order/overlap.ts` decides when two path sets overlap: they share a path once derived registries are removed, or they meet the same declared contention area. `group.ts` turns that into groups of open pull requests. `turn.ts` folds the new `pr.ordered` event into the `pr_order` projection, derives `turnOf` for a group, and counts `needsUpdate` and `needsVerification` in shadow. The turn skips a member parked on a `changes` verdict, red CI, a queued or leased answer, a card hold or an open owner question, and goes to a member holding a leased update or merge; a pull request not observed yet is grouped by its card's declared touches. `needsUpdate` holds on GitHub `dirty`, on a path overlap with what main changed since the head, on a truncated main, and on CI red on the pull request while green on main; the bus records no CI of main yet, so that last condition counts nothing in the running bus until O3 ([#1916](https://github.com/E1i/mikoshi-construct/issues/1916)), the slice that first acts on `needsUpdate`, records it. The supervisor runs this fold on every tick: it writes `pr.ordered` once per life of a pull request, when it first reaches pass + green, prints the shadow counts, which nothing acts on yet, and records each change of the groups, their turns and the shadow counts as a `pr.groups` event. The board's services screen reads the latest `pr.groups` and shows each group with its modules and its turn, and the shadow counts, so the product build carries no bus code. The window request `order.move --pr <N> [--before <N>]` writes `pr.ordered {before, by: window}`, which moves the pull request ahead of the one it names, or to the tail. `importClosure` moved from the supervisor to `scripts/core/import-closure.ts`. `scripts/core/order/` is the new module `order`, `import-closure.ts` belongs to `session`, and session and window may use `order`.

- [#1635](https://github.com/E1i/mikoshi-construct/pull/1635) [`883a663`](https://github.com/E1i/mikoshi-construct/commit/883a663a248ec7d5e38cfae07142518d420e522c) Thanks [@E1i](https://github.com/E1i)! - The edge lists of the `src/` dependency policy come from `declarations/may-use/`, one file per module of `internal-modules.json`, listing `may_use` (the modules it may import), `may_use_factory` (the files under `scripts/` it may import) and `may_use_factory_within` (more of them for a sub-folder). `pnpm declarations:update` validates the entries and assembles them, sorted by file name, into `contract/eslint-edges.json`. `eslint.config.mjs` reads `ALLOWED_INTERNAL_IMPORTS`, `CORE_FILES_SRC_MAY_IMPORT` and `ALLOWED_FACTORY_IMPORTS` from that file and keeps all of its own rules. To add an edge, add or edit a declaration; `eslint.config.mjs` stays as it is.

- [#1633](https://github.com/E1i/mikoshi-construct/pull/1633) [`5adb15d`](https://github.com/E1i/mikoshi-construct/commit/5adb15d44e5ba44a5386d70e665282df2b67bafa) Thanks [@E1i](https://github.com/E1i)! - Modules declare what they own in `declarations/`, one JSON file per entry grouped by kind: `modules` (`layer`, `paths`, `exclude`, `shared`), `contention` (the `bus-restart` area until P-restart) and `generated`, which now holds the generated-file rows that `scripts/core/generated-files.ts` used to list. The package ships `declarations/generated`. `pnpm declarations:update` checks that every tracked file has exactly one owner and rebuilds `contract/module-files.json`.

- [#1527](https://github.com/E1i/mikoshi-construct/pull/1527) [`44f23c8`](https://github.com/E1i/mikoshi-construct/commit/44f23c890bfcecf28c8e63e6361b35930c705655) Thanks [@E1i](https://github.com/E1i)! - `scripts/core` runs no git and imports no `child_process`: each node's composition reads the code sha through `scripts/ports/git.ts` and hands it to `runNode`, and the callers of the push policy hand `pushPolicyOf` the port's reader.

- [#1413](https://github.com/E1i/mikoshi-construct/pull/1413) [`218d695`](https://github.com/E1i/mikoshi-construct/commit/218d695a59c103074f929df404071c18c97295b5) Thanks [@E1i](https://github.com/E1i)! - The history of owner decisions reads `decision.recorded` events, so every recorded decision keeps its own event and date whatever the `decisions` table holds, and a decision number stays given after its row has left the table.

- [#1501](https://github.com/E1i/mikoshi-construct/pull/1501) [`a9741f9`](https://github.com/E1i/mikoshi-construct/commit/a9741f9a16cba31796a233a3f86b318efc863a2c) Thanks [@E1i](https://github.com/E1i)! - A decision imported from `owner-decisions.md` whose words end it «до <YYYY-MM-DDTHH:MMZ>» now expires at that term. Before, the import read a term only from an `· until` tail, so it left the bus's `until` column empty and the decision stayed in force after its date. The import now takes a single calendar term after «до» as the decision's term: it writes `· until <term>` into the bound text, which fills the column, it leaves out a decision whose term has passed, and `pnpm decisions` no longer prints such a decision to a session. A bare date or two different terms in one decision are left as they were.

- [#1497](https://github.com/E1i/mikoshi-construct/pull/1497) [`aa81c7b`](https://github.com/E1i/mikoshi-construct/commit/aa81c7bd5c450f2a7dfc3bc04655d35ff31089a7) Thanks [@E1i](https://github.com/E1i)! - `decisions:add` no longer gives one number to two decisions or leaves the decisions files in a state that blocks every later decision. It holds an exclusive lock file, `owner-decisions.md.lock`, while it reads both files, picks the next number, writes, and records the decision in the bus. A second `decisions:add` waits up to five seconds for that lock, then stops and writes nothing. The refusal names the process holding the lock and says to remove the lock file if no `decisions:add` is running. A failed add restores only a file that still holds what it wrote, so it never erases what another writer put there. When older decisions move to the archive, every record of a number moves together, or none of them do, so one number never ends up in both the working file and the archive. `--supersedes D-N` now retires every record of D-N. A number that appears twice is refused with the command that resolves it: `pnpm decisions:add --supersedes D-N "[owner] …"`. Rebuilding the decisions file from the bus keeps both files unchanged if the rebuilt files would fail the check.

- [#1574](https://github.com/E1i/mikoshi-construct/pull/1574) [`5fb714b`](https://github.com/E1i/mikoshi-construct/commit/5fb714b97684509a8c53e1d7a9d7ebbd2e5e5e91) Thanks [@E1i](https://github.com/E1i)! - The owner wait a card opens after an empty answer round now closes when one of the exits its own text names has happened: a new head on the card's pull request, an amend of the card, or a decision bound to it. Before, a new head only let the next answer round start and left the wait open, so the merge of that head was denied `owner_question_open` on a question its own text called lifted. A decision wait of the card opened by any other path is left open.

- [#1487](https://github.com/E1i/mikoshi-construct/pull/1487) [`5412b36`](https://github.com/E1i/mikoshi-construct/commit/5412b363d40f643401ec09de7d242a75edf27e06) Thanks [@E1i](https://github.com/E1i)! - One supervision for card and answer sessions. A window start ends with its window session, so a later takeover is no longer refused by a start that never ends. `bus:run` sweeps the leased launch and answer tasks: a session with no push and no context change past 30 minutes is closed and queued again when its process is gone, and raises one `session.stalled` event with its reason while it lives. The pid check of a recorded worker moved from `review-bg.ts` to `recorded-worker.ts`, and the launch node reads a card session whose recorded pid is gone as ended. An answer round merges main into the card tree before its session through the update node's merge, and a conflicting merge leaves the tree as it was and goes the update node's conflict path. A pull request the update node brought up to date with main is queued for merge without a window step.

- [#1472](https://github.com/E1i/mikoshi-construct/pull/1472) [`b4dd424`](https://github.com/E1i/mikoshi-construct/commit/b4dd424d282350edcde3f605b6ddf2b7b4bceb7a) Thanks [@E1i](https://github.com/E1i)! - `pnpm decisions:add --card #N --creates <path>` adds a file the owner's decision requires to the card's touches before the decision is requested, so the card does not stop on a touch outside its declaration. A refused witness downgrade at intake prints the ready `pnpm decisions:add` command with the exact phrase intake accepts, and intake now accepts a card-bound decision that names the card, the witness ids and the word «понижение» in any order. `scripts/ci/sandbox-failing.jsonl` is a shared append file, so cards that append to it no longer wait for each other.

- [#1533](https://github.com/E1i/mikoshi-construct/pull/1533) [`8d205dd`](https://github.com/E1i/mikoshi-construct/commit/8d205dd11acac31c842176c03a4a7b34e34fa325) Thanks [@E1i](https://github.com/E1i)! - Intake no longer admits `contract/factory.json` in a card's touches: it removes the entry and prints a correction, `touches — contract/factory.json → (removed) — …`, naming `scripts/contract/factory/*.ts` as the contract's source and the bus as the file's writer. After a card session ends, the shift runs `pnpm contract:update` in the card tree, when the tree carries `contract/factory.json`, and commits the rebuilt contract in the same commit as the sources that changed it, before the pull request opens. A session's own edit of the file is overwritten by that rebuild. When the bus merges a fresh `origin/main`, a conflict on the rebuilt files takes main's side and the contract is rebuilt again. A rebuild that fails opens no pull request and returns the card to its session once, with `twin-unbuilt`, to fix the sources.

- [#1445](https://github.com/E1i/mikoshi-construct/pull/1445) [`1c02d8a`](https://github.com/E1i/mikoshi-construct/commit/1c02d8a7d88a372a3714c8599e0347d215376e0a) Thanks [@E1i](https://github.com/E1i)! - Every port in `contract/factory.json` now records which language it speaks: `factory` when its exported surface names only the factory's own words, `technology` when it names a technology such as `git`, `gh`, `lsof` or `stdout`, with those words listed in `technologyWords` so a reader can check the mark. The generator keeps no list of technology words: each technology port declares its own in an exported `TECHNOLOGY_WORDS`, the client adapter contributes its id, and the generator only collects them, so a new word is added in its adapter alone.

- [#1439](https://github.com/E1i/mikoshi-construct/pull/1439) [`fd3c263`](https://github.com/E1i/mikoshi-construct/commit/fd3c2634a8d62c626fd066444e0755a34a5a6696) Thanks [@E1i](https://github.com/E1i)! - `contract/factory.json` versions its bus, card, ports and nodes sections, and `pnpm contract:bump` is red when a section changes without its version growing.

- [#1426](https://github.com/E1i/mikoshi-construct/pull/1426) [`8998460`](https://github.com/E1i/mikoshi-construct/commit/8998460e9da9d441f101ee3c7446b0a9180dcca4) Thanks [@E1i](https://github.com/E1i)! - The generated files are listed once, in `scripts/core/generated-files.ts`: two cards sharing only such a file no longer overlap, an update rebuilds them after a merge of main, and the contract records get a layer of their own.

- [#1463](https://github.com/E1i/mikoshi-construct/pull/1463) [`1c34dbe`](https://github.com/E1i/mikoshi-construct/commit/1c34dbee30b586bbdc711707367dd31794f35e8b) Thanks [@E1i](https://github.com/E1i)! - The ladder (`scripts/ladder/`) runs git only through the port `scripts/ports/git.ts`, which now holds a process adapter and an in-memory one, and a test fails on a git call in the ladder outside it. The git overlaps the factory counts drop from 72 to 53. A git error inside the ladder supervisor now carries git's stderr in its message instead of printing it to the supervisor log.

- [#1505](https://github.com/E1i/mikoshi-construct/pull/1505) [`f8b1bb4`](https://github.com/E1i/mikoshi-construct/commit/f8b1bb4080bfeadccf9638ad31efb4b7a3710e3e) Thanks [@E1i](https://github.com/E1i)! - The answer, close, launch and review nodes now run git only through `scripts/ports/git.ts`: `answerer.ts`, `answer/duties/tree.ts`, `close-executor.ts`, `ended-card-trees.ts`, `lane-assign.ts`, `launch-root.ts`, `launch-starter.ts`, `tree-pr-cli.ts`, `depth-sources.ts` and `reviewer.ts` call `processGit` instead of spawning git themselves. Each call keeps its arguments and its error. A seal test, `scripts/tests/ports/git-seal-nodes.test.ts`, fails when a node calls git outside the port. The ratchet's `overlaps:git` goes down from 53 to 38.

- [#1507](https://github.com/E1i/mikoshi-construct/pull/1507) [`e88391a`](https://github.com/E1i/mikoshi-construct/commit/e88391a96e224c02fea8972f59ed0be01b9dd94d) Thanks [@E1i](https://github.com/E1i)! - The release and contract scripts now run git only through `scripts/ports/git.ts`: `contract/bump.ts`, `contract/declared.ts`, `contract/json-samples.ts`, `contract/surface.ts`, `release/changesets.ts`, `release/evidence.ts` and `release/security-diff.ts` call `processGit` instead of spawning git themselves. Each call keeps its arguments and its outcome. A seal test, `scripts/tests/ports/git-seal-release-contract.test.ts`, fails when a release or contract script calls git outside the port. The ratchet's `overlaps:git` goes down from 38 to 27.

- [#1512](https://github.com/E1i/mikoshi-construct/pull/1512) [`93b1e6e`](https://github.com/E1i/mikoshi-construct/commit/93b1e6e76094635c6cc002ee2e9be2707f302745) Thanks [@E1i](https://github.com/E1i)! - The window, ci, supervisor, tree and remaining scripts run git only through `scripts/ports/git.ts`, with a seal test and `overlaps:git` down to 0.

- [#1459](https://github.com/E1i/mikoshi-construct/pull/1459) [`485904c`](https://github.com/E1i/mikoshi-construct/commit/485904cd33f568d0ab63ea64dedaf0a48bc7e141) Thanks [@E1i](https://github.com/E1i)! - The STATUS line of a handoff is now read in one place, `scripts/core/handoff-status.ts`, and the last STATUS line is the status everywhere. The board used to show the first STATUS line while the loop, the tab window and `miko exit` acted on the last, so a handoff that moved from OWNER to CONTINUE could still show as waiting for the owner. A test fails when a STATUS parse appears outside that module. `handoff:write` under a decisions shard now accepts `STATUS: OWNER` when the handoff's `owner waits` names an open question, since the window cannot decide an item the owner already holds.

- [#1420](https://github.com/E1i/mikoshi-construct/pull/1420) [`cb22004`](https://github.com/E1i/mikoshi-construct/commit/cb22004ff4dc94786de3fb523b27e35f3fa34592) Thanks [@E1i](https://github.com/E1i)! - A ready card with no live depends no longer waits behind a long chain when every lane is occupied: lane layout moves it to the least loaded lane it has no touches overlap with, when that lane holds fewer waiting cards than its own by more than the size of the moving part. A card with real depends, a card the owner moved, a parent with a dependant in its lane and a card overlapping a started card stay where they are.

- [#1589](https://github.com/E1i/mikoshi-construct/pull/1589) [`8c45420`](https://github.com/E1i/mikoshi-construct/commit/8c4542012bf0e81bcdc9a107c2e84099c66a1fc5) Thanks [@E1i](https://github.com/E1i)! - `intake --admit` and `--amend` now read the owner's standing decision that moving a witness to another card is not a downgrade. They read it through the decisions port. A removed witness no longer opens an owner wait when another admitted card that has not ended holds the same `run` and `test`. A witness that no card holds still waits for the owner. Every wait intake leaves now writes a `card.waiting` with a wait record. The record uses the kinds and terms of the card section's `waits` table: what the card waits for, who lifts the wait and the deadline. Intake leaves four such waits: unmerged depends (the bus lifts it), a witness downgrade (the owner), a card held until its corrections are confirmed (the owner, or the window under a shard) and a card given to the window (the window). The law registry now has witnesses for Z3 × intake and Z4 × intake in place of their gap rows, and `contract/ratchet.json` drops both rows.

- [#1492](https://github.com/E1i/mikoshi-construct/pull/1492) [`7e95095`](https://github.com/E1i/mikoshi-construct/commit/7e950953be72370a85144751d99eac90e65db167) Thanks [@E1i](https://github.com/E1i)! - Intake no longer proposes slices for a card whose draft states `whole:`: the complexity, volume and risk seams write no `slice:` lines for it, and its risk seam alone no longer holds it for confirmation. When other cards of the run wait for confirmation, a whole card is not listed under Held: it prints one line, `Whole: <card> (whole: <reason>)`, with no `seam:`, `slice:` or `risk:` lines under it. A lock file (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock` and the like) is grouped with the `package.json` or `pnpm-workspace.yaml` in its directory or below it, and a lock file with no manifest among the touches rides with another touch, so no slice is ever just the lock file.

- [#1478](https://github.com/E1i/mikoshi-construct/pull/1478) [`aa3a637`](https://github.com/E1i/mikoshi-construct/commit/aa3a637134a605a62511b50cd98cac081afabd9d) Thanks [@E1i](https://github.com/E1i)! - `construct board` and `construct cost` read ladder runs from the bus (`ladder.run`, bus version 3), falling back to `.construct/runs.jsonl` only while the bus holds none; `pnpm bus:import` moves the frozen file in once and is the only writer, since nothing appends `ladder.run` going forward.

- [#1491](https://github.com/E1i/mikoshi-construct/pull/1491) [`90eb6c0`](https://github.com/E1i/mikoshi-construct/commit/90eb6c0e32494c39b50aeeb7ca774b46d2b450f7) Thanks [@E1i](https://github.com/E1i)! - The factory keep-alive no longer restarts `construct-factory` every 20 seconds while the factory is running. The launchd agent ran the starter, the starter found the bus processes running, left them alone and exited 0, and launchd started it again: thousands of launches a day, enough to raise the machine's load. The agent now runs `construct-factory --hold`, which starts what is missing and then stays up while the supervisor of its bus runs, checking every 20 seconds; once the supervisor is gone it exits non-zero and launchd starts the factory again. Run by hand, `construct-factory` still starts the factory and returns. An agent installed by an older version is rewritten the next time `construct-factory` runs in its repository.

- [#1587](https://github.com/E1i/mikoshi-construct/pull/1587) [`7a73d23`](https://github.com/E1i/mikoshi-construct/commit/7a73d238179f242bdbe9df1dc598dd103033c7bd) Thanks [@E1i](https://github.com/E1i)! - A card that drops an import may now delete the entry of `.dependency-cruiser-known-violations.json` that the import made stale, without that file in its touches (D-514). The answer round, the review and the merge let the file follow the touches only when the change removes entries and adds or alters none; the merge reads that from the pull request's patch and the file at its head. A grown or altered list stays outside the touches: the answer node still drops it and sends the answer back, and the merge still refuses it.

- [#1485](https://github.com/E1i/mikoshi-construct/pull/1485) [`1ce99de`](https://github.com/E1i/mikoshi-construct/commit/1ce99de5f47c06c9e464ca399917b0aa1e628196) Thanks [@E1i](https://github.com/E1i)! - The launch worker is now split into its composition root and its node. `scripts/nodes/launch/launch-root.ts` is the entry `bus:launch` starts: it wires the starter ports, the ladder steps and the report readers. `scripts/nodes/launch/launch-worker.ts` keeps only the launch node. Behaviour does not change. The file no longer goes over the line threshold, so its entry leaves `contract/ratchet.json`.

- [#1552](https://github.com/E1i/mikoshi-construct/pull/1552) [`5b5c3ef`](https://github.com/E1i/mikoshi-construct/commit/5b5c3efba1800d92c8ec8398c00cc8ad35901e39) Thanks [@E1i](https://github.com/E1i)! - The law registry no longer has a cell that names a merged card. Six cells now have a witness that calls the code of its own node, measured by V8 coverage: Z2 × answer, Z2 × launch, Z2 × update, Z3 × answer, Z4 × answer and Z5 × launch. The answer witnesses run through `AnswerNode` and the update witness through `UpdateNode`, not their executors. The launch witnesses read the handoff and the report through `launch-root.ts`. Their gap rows leave `contract/ratchet.json`. No merged card's witness ([#1672](https://github.com/E1i/mikoshi-construct/issues/1672), [#1754](https://github.com/E1i/mikoshi-construct/issues/1754), [#1764](https://github.com/E1i/mikoshi-construct/issues/1764), [#1767](https://github.com/E1i/mikoshi-construct/issues/1767), [#1789](https://github.com/E1i/mikoshi-construct/issues/1789)) calls its node, so each cell that named one of those cards, and each cell still waiting for a witness, now names the open card [#1823](https://github.com/E1i/mikoshi-construct/issues/1823), law-cells-40-witnesses. The Z4 cells keep [#1740](https://github.com/E1i/mikoshi-construct/issues/1740) beside it, and Z3 × merge names [#1784](https://github.com/E1i/mikoshi-construct/issues/1784). The frozen list of 31 cells that were allowed to name a merged card is gone. A single list of the closed cards judged today, this card included, now decides whether a gap is legal, and the law-sites suite checks that no cell names a card on it. The laws section of the factory contract moves to version 3.

- [#1452](https://github.com/E1i/mikoshi-construct/pull/1452) [`4b1a420`](https://github.com/E1i/mikoshi-construct/commit/4b1a4208b065de1b1e34aaec92304d25274cd2c7) Thanks [@E1i](https://github.com/E1i)! - Which layer a file belongs to has one answer, `scripts/core/layer-map.ts`, and the CI selector, a card's runs and the check catalog read it from there. Architecture and docs pages, skills, commands and `README.md` get a `docs` layer whose tests are the ones that read them, a new test file not yet in the graph runs itself, and a code file in no layer still runs the full suite.

- [#1499](https://github.com/E1i/mikoshi-construct/pull/1499) [`f03561e`](https://github.com/E1i/mikoshi-construct/commit/f03561ead0edbaa50a37813ebe2f5bf9595f1d53) Thanks [@E1i](https://github.com/E1i)! - The board page no longer reads `bus offline` while the launch node is running cards. The header used to look only at the window heartbeat. Now a card session that has beaten within the last few minutes also counts as live, so a stale supervise or window signal next to running card sessions no longer reads as a dead factory.

- [#1423](https://github.com/E1i/mikoshi-construct/pull/1423) [`81b890d`](https://github.com/E1i/mikoshi-construct/commit/81b890d0d1fea4a41d10bb3f19d7b1ca6cc8a9ae) Thanks [@E1i](https://github.com/E1i)! - The machine's session limit now has a default: with no valid `limit.json`, a machine runs a quarter of its cores in sessions, at least one, instead of running without a limit. A session's vitest workers are at most cores divided by that limit, so a lone session on 16 cores with limit 4 gets 4 workers, not 15.

- [#1496](https://github.com/E1i/mikoshi-construct/pull/1496) [`ff3223f`](https://github.com/E1i/mikoshi-construct/commit/ff3223f98c225ae348c7684aad30129d4fb6b07f) Thanks [@E1i](https://github.com/E1i)! - The merge node no longer faults a card that its answer is fixing. Before, a merge task stayed queued after the review verdict on its head turned to changes. Each retry counted as a failure, and the third one stopped the card as a fault while the answer session was still fixing it. Now the merge task is withdrawn without a failure and waits for the new head the answer brings. A head with no verdict yet is still retried as before.

- [#1570](https://github.com/E1i/mikoshi-construct/pull/1570) [`ca5624b`](https://github.com/E1i/mikoshi-construct/commit/ca5624b47e3761311d5c797406ce7ff266a6cced) Thanks [@E1i](https://github.com/E1i)! - `node --import tsx scripts/contract/module-graph/report.ts` prints one machine report of the module graph: the report version and a `sha256` version of the spec, the files and their holder, the modules, the file imports and the module edges, the violations with their reasons, the cycle components with an example chain each, and the `may_use` cycles. Two runs on one commit print the same bytes: every list is in an explicit sorted order, and the report holds no timestamp, absolute path or random id. Its statistics count an import once; the reasons sit in a table of their own, marked that one import may carry several, so their counts do not add up to the violating imports. The spec and `contract/ratchet.json` do not change.

- [#1564](https://github.com/E1i/mikoshi-construct/pull/1564) [`0ea73d6`](https://github.com/E1i/mikoshi-construct/commit/0ea73d69915a69758dc4c97f22ace292b1bb4b5a) Thanks [@E1i](https://github.com/E1i)! - The factory's module graph now has a boundary check. `scripts/contract/module-graph/imports.ts` builds the import graph of `src/` and `scripts/`, counting type-only imports, re-exports, dynamic `import()` and path aliases; `boundary.ts` holds each edge between two modules against the `modules` section: an import is lawful only when its target is in the target module's contract and that module is in the importer's `may_use`, and an undecided module legalises no edge into or out of it. The report — graph, violations and the strongly connected modules — is byte-identical across runs on one commit. The violations that exist today are recorded in `contract/ratchet.json` as `boundary:<from>-><to>` rows: a new row or a higher count is red, and a row that drops must be lowered in the same pull request. No violation is fixed and no file moves.

- [#1565](https://github.com/E1i/mikoshi-construct/pull/1565) [`b5c3a40`](https://github.com/E1i/mikoshi-construct/commit/b5c3a4024469e9ea82538f40215d4f22fe69395b) Thanks [@E1i](https://github.com/E1i)! - The factory's module graph now checks its cycles. `scripts/contract/module-graph/cycles.ts` holds the `may_use` graph of the `modules` section to be a DAG — a cycle in it, a module naming itself included, is red — and reports the cycles that exist in the source apart from it: each strongly connected set of modules with one example chain, every step of which names the import that carries it. The two graphs are never mixed: a source cycle does not make `may_use` red, and a `may_use` cycle is not a source SCC. Run directly, the script prints the number of modules, the boundary violations by kind, the `may_use` cycles and the source SCCs with their chains. No cycle is fixed and no file moves.

- [#1562](https://github.com/E1i/mikoshi-construct/pull/1562) [`b6d65f3`](https://github.com/E1i/mikoshi-construct/commit/b6d65f33b955ac31acead147cc55632843e82e87) Thanks [@E1i](https://github.com/E1i)! - `contract/factory.json` gains a `modules` section: the factory's target modules, each with the files it owns, the subset that is its public contract, the modules it may use and whether its border is decided, plus the composition roots and an explicit list of what stays out of the graph (tests, templates, tooling). The section is built from `scripts/contract/factory/modules.ts` beside the concepts registry and names under each module the concepts whose owner lies in it. A test now fails when a file under `src/` or `scripts/` belongs to no module and no exclusion, or to more than one. No file moves and no import changes.

- [#1568](https://github.com/E1i/mikoshi-construct/pull/1568) [`42d50d1`](https://github.com/E1i/mikoshi-construct/commit/42d50d1d66013605281be943fb9d3f6a308b719f) Thanks [@E1i](https://github.com/E1i)! - The module graph knows a third status, `tool`. A tool sees every module and is not part of the architecture graph: its own imports are never a violation, it is in no cycle component and no `may_use` may name it, and an import into it is a violation with the reason `into-tool`. The contract generator under `scripts/contract/` becomes the tool `contract-generator`; `scripts/contract/contours.ts`, the one file `scripts/ladder/handoff.ts` and `scripts/ladder/verdict.ts` import at runtime, stays in the undecided `factory-contract`. Twenty-two `boundary:factory-contract->*` rows vanish from `contract/ratchet.json`, 56 violating imports in all; no row is added.

- [#1486](https://github.com/E1i/mikoshi-construct/pull/1486) [`3a5ab1f`](https://github.com/E1i/mikoshi-construct/commit/3a5ab1fd5158a85c289c88ed202225c56172555c) Thanks [@E1i](https://github.com/E1i)! - No silent waits in window requests, the owner channel and the merge policy. `owner.wait.close --id Q<N> --from owner-channel` closes a wait on the owner's channel word that starts with the question id (`pnpm owner:say "Q<N>: <answer>"`), so the window no longer needs the verbatim line; a refusal names the word it waits for and how the owner gives it. A card held for the owner can be taken over by the window: the hold and the takeover are two layers, a release lifts the latest one, and a release that leaves the owner's hold standing queues no answer and says who still holds the card. An amend whose touches cover the paths an owner stop asked for queues the stopped answer again, and an amend that does not settle the stop names what the card still waits for. The `unsandboxed_command` rule compares the sets of symbols imported from `child_process` instead of the import lines, so a reordered, reformatted or type-only import stays auto and a newly imported symbol is named.

- [#1429](https://github.com/E1i/mikoshi-construct/pull/1429) [`8622342`](https://github.com/E1i/mikoshi-construct/commit/86223425fdb3913c1f713b7c9b12b768e44ef27c) Thanks [@E1i](https://github.com/E1i)! - cli: `miko:watch` no longer raises a stall for a held card whose pull request was closed; a held card with an open pull request and a card with no hold still raise one.

- [#1548](https://github.com/E1i/mikoshi-construct/pull/1548) [`0a610f1`](https://github.com/E1i/mikoshi-construct/commit/0a610f1d25219d6334e0542f00c6026186d37005) Thanks [@E1i](https://github.com/E1i)! - A session that stops on paths outside its card's touches, or on an open question, no longer spends a continuation. The card stops with the reason recorded in the bus, and it is not launched again until intake widens the touches or the question closes (law Z8).

- [#1627](https://github.com/E1i/mikoshi-construct/pull/1627) [`96e3488`](https://github.com/E1i/mikoshi-construct/commit/96e3488bd8b10b3d170a5abdbd0ab930f7d544d3) Thanks [@E1i](https://github.com/E1i)! - cli: `pnpm owner:answer <Q|#card> "words"` answers one open owner wait in one step. It chooses the request from the kind of the wait and the round count of the pull request, writes continue-fixes for the current head past the round limit, and when nothing closes it says why.

- [#1575](https://github.com/E1i/mikoshi-construct/pull/1575) [`de72c36`](https://github.com/E1i/mikoshi-construct/commit/de72c361f2283bb5528c16336e826d1f2f1040ac) Thanks [@E1i](https://github.com/E1i)! - cli: the atlas page names `construct atlas` through the one owner-commands source, so its hint follows the command if it is renamed.

- [#1466](https://github.com/E1i/mikoshi-construct/pull/1466) [`f5a7d8d`](https://github.com/E1i/mikoshi-construct/commit/f5a7d8daea254eddf0fd9eb12c17b2c6fded852b) Thanks [@E1i](https://github.com/E1i)! - The factory contract's `owner-commands` count no longer counts a command the code runs itself. A pnpm or construct command line is left out when it is an argument of a call that runs a command (a function named `exec…`, `spawn…`, `run…` or `shell…`, or a method named `exec…`, `spawn…` or `shell…`), when a generator yields it to its runner, or when it is a constant the file passes to one of those. A command shown to the owner in a message, a usage line or a bound statement parameter is still counted. `overlaps:owner-commands` goes from 179 to 174: the two `pnpm install --frozen-lockfile` the witness runners run, the eslint command `scripts/ports/witnesses.ts` yields, and the `pnpm run quality` harness argument the surface and JSON-sample scripts pass to the CLI.

- [#1571](https://github.com/E1i/mikoshi-construct/pull/1571) [`5e85b80`](https://github.com/E1i/mikoshi-construct/commit/5e85b80bb96c7b432904234af08906a24453c696) Thanks [@E1i](https://github.com/E1i)! - The lore and plain lines in `src/ui/lore.ts` take the `construct` and `pnpm` command lines they name from `scripts/core/owner-commands.ts`; the row of `src/ui/lore.ts` leaves the pending table, and the ratchet's `overlaps:owner-commands` falls to its new minimum. The text of every line is unchanged.

- [#1535](https://github.com/E1i/mikoshi-construct/pull/1535) [`5a08c9c`](https://github.com/E1i/mikoshi-construct/commit/5a08c9c7ae3accd38e014d43577d43cacb4b2558) Thanks [@E1i](https://github.com/E1i)! - The command lines the owner is told to run have one owner, `scripts/core/owner-commands.ts`, which builds a `pnpm` or `construct` line from its parts; `src/` may import it. A seal test holds every file that still writes such a line itself to the count `scripts/tests/core/owner-commands-pending.json` records, so a new literal outside the owner fails the suite, and the next slices move their layer's lines into the owner and drop their rows.

- [#1569](https://github.com/E1i/mikoshi-construct/pull/1569) [`f85a0ad`](https://github.com/E1i/mikoshi-construct/commit/f85a0ad6af0fe2b49d2c87b22c87f21128e43037) Thanks [@E1i](https://github.com/E1i)! - `src/program.ts` reads the `pnpm mutate judge` command in the `mutate judge --card` help text from its owner, `scripts/core/owner-commands.ts`, instead of spelling it out. The help text is unchanged. `src/program.ts` leaves the owner-commands pending list, and the `owner-commands` overlaps fall from 116 to 115.

- [#1557](https://github.com/E1i/mikoshi-construct/pull/1557) [`d845af0`](https://github.com/E1i/mikoshi-construct/commit/d845af0518ed34fd90e30d2984058bd3274c5ec6) Thanks [@E1i](https://github.com/E1i)! - `init` and `attach` take the command lines they print from `scripts/core/owner-commands.ts`: the default harness command and the `npx mikoshi-construct attach` rerun line come from the owner, and their rows leave the pending table. The text either writes is unchanged.

- [#1600](https://github.com/E1i/mikoshi-construct/pull/1600) [`4472ae0`](https://github.com/E1i/mikoshi-construct/commit/4472ae000f0e5a65ea1a097a15418e8bd2f46bc1) Thanks [@E1i](https://github.com/E1i)! - `board`, `doctor` and `intake` take the command lines they print from `scripts/core/owner-commands.ts`: the board's decision, plan and admit hints, the doctor's `construct sync --apply`, ghost-protocol and handoff lines, its `construct init` hint, and the intake numbering reason come from the owner, and their rows leave the pending table. The text each prints is unchanged.

- [#1556](https://github.com/E1i/mikoshi-construct/pull/1556) [`ec6bd15`](https://github.com/E1i/mikoshi-construct/commit/ec6bd150aeb728f1fd82d2f9b0be37f425d75c8e) Thanks [@E1i](https://github.com/E1i)! - The owner decisions modules live in one folder, `scripts/policy/decisions/`: the bus table and its folds in `index.ts`, the import of the decisions file in `import.ts`, and `decisionsFileOf`, which `doctor` and `intake` use to find a bus's decisions file, beside the parser in `decisions.ts`. No behaviour changes.

- [#1560](https://github.com/E1i/mikoshi-construct/pull/1560) [`aa17ae9`](https://github.com/E1i/mikoshi-construct/commit/aa17ae98ae1c1b515841272e4ef1117e1b28d87f) Thanks [@E1i](https://github.com/E1i)! - Every reader of the owner decisions goes through `scripts/policy/decisions/`. `intake` reads the right to lower a witness from the decisions in force in the bus, through a decisions port (`BusDecisions`, with `InMemoryDecisions` for tests), and only from a decision the owner recorded with `decisions:add`; a line added to `owner-decisions.md` by hand no longer grants it, because that file is only a projection for people to read. A rebuild of the projection no longer leaves a decision both in `owner-decisions.md` and in its archive. A test now fails when code outside the folder reads the decisions.

- [#1566](https://github.com/E1i/mikoshi-construct/pull/1566) [`c960702`](https://github.com/E1i/mikoshi-construct/commit/c960702d29b614ca8de23f034e68cc45544f22fe) Thanks [@E1i](https://github.com/E1i)! - The owner's word now moves any card past the bus's timers and automatic conditions. Four owner commands, built in `scripts/core/owner-commands.ts`, are window requests: `owner.stop --card N` ends the card's live session, `owner.launch --card N` starts a standing card on the launch node's next lease even if it is held, stopped on a question, past a usage limit, waiting for its lane or blocked by the machine limit, `owner.takeover --card N` gives the card to the window at once without the 30 minutes, and `owner.requeue --task <key>` queues a task again with no `board.alarm` and no round or requeue limit. Each move runs only after the owner says the exact command line into the owner channel. It is recorded as one `command.executed` event with the owner as actor. It is refused only when it cannot physically happen (no live session, no admitted body, no card, no task, or no open pull request), and the refusal names the cause. The law is registered as Z10 in the laws registry, and the laws version is now 5.

- [#1597](https://github.com/E1i/mikoshi-construct/pull/1597) [`086a1d3`](https://github.com/E1i/mikoshi-construct/commit/086a1d3b653c05dcf42014323d85f5496971e8b0) Thanks [@E1i](https://github.com/E1i)! - A card question asking a `contract/ratchet.json` row to grow now stops for the owner the first time it is asked (`card.stopped` `question.owner` with an open owner wait), not as an agent question the answer node keeps re-running. A reworded ask for the same row reuses the open wait and starts no answer session.

- [#1416](https://github.com/E1i/mikoshi-construct/pull/1416) [`f6daf27`](https://github.com/E1i/mikoshi-construct/commit/f6daf27e77a4795d39bd0ae1b808743d66dfb784) Thanks [@E1i](https://github.com/E1i)! - cli: `owner.wait.close` without `--from answer` is now refused unless it records a decision under a live decisions shard, so a window can no longer close an owner wait without the owner's word.

- [#1516](https://github.com/E1i/mikoshi-construct/pull/1516) [`b0815d2`](https://github.com/E1i/mikoshi-construct/commit/b0815d2e0cc3bd2b8118e6a70d4cb0766b1e2255) Thanks [@E1i](https://github.com/E1i)! - The gh, worktree, session and snapshot ports each carry an in-memory adapter — `InMemoryGh`, `InMemoryTrees` with `InMemoryShell`, `InMemorySessions` and `InMemoryPulls` — that answers from a script and records its calls, so a test of a node behind those ports runs without spawning git, ps, gh or a client session.

- [#1524](https://github.com/E1i/mikoshi-construct/pull/1524) [`9310169`](https://github.com/E1i/mikoshi-construct/commit/9310169decf0d9a92b22e9159d28f99ea2a1c0b4) Thanks [@E1i](https://github.com/E1i)! - `construct intake --admit` and `--amend` keep the owner's order: a readmission of an admitted card whose text carries no `priority:` line keeps the priority of the card's latest admission, so the launch node no longer reads it as none. `construct intake --amend` and `pnpm bus:request amend` take `--priority p0|p1|p2|none`; `none` is the only way to clear it. A JSON intake draft takes `priority` and writes it into the parked card. A priority-only amend is not a new card body: the launch node does not restart a live session on it, and answer and merge tasks keyed on the body stay.

- [#1451](https://github.com/E1i/mikoshi-construct/pull/1451) [`78ec33d`](https://github.com/E1i/mikoshi-construct/commit/78ec33d3a2f41cba57b221b2e6e48fea9537196c) Thanks [@E1i](https://github.com/E1i)! - The factory reads the OS process table through one port, `scripts/ports/process-table.ts`: a snapshot of rows (pid, parent, group, start, command), the working directories of our client and a CPU sample, with a live adapter over `ps`, `lsof` and `top` and an in-memory one for tests. The port answers facts only and has no notion of a pid being alive; the nine places that ran `ps` or `lsof` themselves now ask it. The three holders that serve a bus stop probing pids: `bus:review:bg` reads the `bus:review` heartbeat, the bus heal stops a recorded node only when the supervisor's snapshot still shows it serving this bus, and a second `bus:run` facing an unreadable process table exits and starts nothing: with a recent `bus:run` heartbeat on that bus it just exits, and without one it also opens an owner wait naming the pid and the lock, and takes no lock, since nothing proves the holder gone. `liveness-sites` gains the kinds `imported-judge`, so a file that imports `alive` or `isAlive` is recorded by name, and `live-session`, so each place that declares whether a client session is alive (`liveSessionIn`, `liveSessionHolds`, `isSessionAlive`, `sessionLiveness`) is recorded by name too; the factory's live-session count reads four such places. A seal test turns red on a `ps`, `lsof` or kill zero outside the port, and on a caller that judges liveness beside it unless `liveness-sites.known.json` records that file for that kind of judgement.

- [#1483](https://github.com/E1i/mikoshi-construct/pull/1483) [`e582f5c`](https://github.com/E1i/mikoshi-construct/commit/e582f5c8487265c312b6cca5c8dc6ecba5bd7a40) Thanks [@E1i](https://github.com/E1i)! - The owner inbox, the board's waits, cards and decisions, and the turn watch say a projection is stale instead of answering from rows behind their events, and the stall alarm reads only a merge denial of the PR's current head.

- [#1494](https://github.com/E1i/mikoshi-construct/pull/1494) [`178121a`](https://github.com/E1i/mikoshi-construct/commit/178121aed2771f9fd1b0dcf89cfb0ae556014220) Thanks [@E1i](https://github.com/E1i)! - The answer node no longer loops on one question. Before, an answer session could repeat, word for word, the question that stopped the card. Each time the card stopped again for the agent and went back to the answer queue. Now the card stops for the owner with one decision wait. A decision bound to the card after the stop still lets the answer run again with that decision in its prompt.

- [#1428](https://github.com/E1i/mikoshi-construct/pull/1428) [`35d9f11`](https://github.com/E1i/mikoshi-construct/commit/35d9f11eb40ed217586a10ee53db1da2f7d8be52) Thanks [@E1i](https://github.com/E1i)! - A merge or witness task left on a pull request the owner merged no longer stays queued for good: the bus withdraws it unless a live lease is finishing the merge. A close task stays while its card is open, and so does a witness task on the base the card's close was denied on; both are withdrawn once the card is closed.

- [#1592](https://github.com/E1i/mikoshi-construct/pull/1592) [`67021c0`](https://github.com/E1i/mikoshi-construct/commit/67021c0f78bd187303033c46c09a359021283827) Thanks [@E1i](https://github.com/E1i)! - The boundary ratchet now finds the base of a pull request in CI. The vitest job checks out at depth 2, and on a pull request or merge-queue run whose HEAD is a merge commit the ratchet reads that commit's first parent as the commit the branch left from; outside CI it keeps the merge-base with `origin/main` or `main`. When neither is reachable and a boundary row grew, the check fails and names why, instead of reading no ownership move at all.

- [#1419](https://github.com/E1i/mikoshi-construct/pull/1419) [`49d5c78`](https://github.com/E1i/mikoshi-construct/commit/49d5c78cbfbb8426638442e8b23bf18b1507c14b) Thanks [@E1i](https://github.com/E1i)! - The ratchet in `contract/ratchet.json` now counts each concept as one number, the sum of its sites over all files, so moving a site from one file to another without raising the sum is no longer growth.

- [#1585](https://github.com/E1i/mikoshi-construct/pull/1585) [`a30a08d`](https://github.com/E1i/mikoshi-construct/commit/a30a08dd5473df82a65cd8066995caac19bab4d4) Thanks [@E1i](https://github.com/E1i)! - The boundary ratchet now reads an ownership move the way D-510 states it. A grown `boundary:<from>-><to>` row passes without the owner when the card changes file ownership in the module spec, the total of violating imports does not grow, and every violating import in the row existed on the commit the card branched from — whether or not it was a violation there. Until now only imports that were already violations on that commit were held, so an import inside one module that a move turned into a cross-module one, as `ports` → `ports-adapters` on the head of PR [#1578](https://github.com/E1i/mikoshi-construct/issues/1578), read as new. An import is still identified by its source file and what it imports; a new or swapped import stays the owner's decision.

- [#1624](https://github.com/E1i/mikoshi-construct/pull/1624) [`2af9519`](https://github.com/E1i/mikoshi-construct/commit/2af9519c3844411d8ffad7936bd052fa7a680f63) Thanks [@E1i](https://github.com/E1i)! - The boundary ratchet reads the module spec of the commit a card branched from out of that commit's `contract/factory.json`, instead of evaluating its `modules.ts` in a separate node process. `contract/factory.json` now publishes `composition_imports` in its `modules` section, and `.dependency-cruiser.mjs` takes the composition module and its listed importers from there, so loading the config spawns no process. A test now holds the rule that an import naming no symbols — default, namespace or side-effect — never counts as carrying moved symbols.

- [#1580](https://github.com/E1i/mikoshi-construct/pull/1580) [`d043772`](https://github.com/E1i/mikoshi-construct/commit/d043772670a63de74ee8c7453ee8ac29d4f496c2) Thanks [@E1i](https://github.com/E1i)! - A `card.started` that the reducer rejected no longer counts as a live session. Before this, `owner.launch` on such a card was refused because the card supposedly "runs the session started at event N", even though no process ran on its tree. An `owner.stop` of a session whose process is gone now has the launch node record `card.session.ended`, so the card can be launched again instead of waiting for a stop that never comes. This also holds when the card has already left the running state. Window-started sessions, which carry no process id, are not affected.

- [#1502](https://github.com/E1i/mikoshi-construct/pull/1502) [`b4aa27a`](https://github.com/E1i/mikoshi-construct/commit/b4aa27a87205f2345980be2e443ffa496e985910) Thanks [@E1i](https://github.com/E1i)! - cli: a release that lands after the answer node read the hold and before it withdrew the answer task no longer strands that task: the answer node queues it again once it finds the hold closed, as the release itself does for a task withdrawn before it.

- [#1433](https://github.com/E1i/mikoshi-construct/pull/1433) [`123f510`](https://github.com/E1i/mikoshi-construct/commit/123f510b08c93bc4616ceadf9b85ea2ef6b9a75c) Thanks [@E1i](https://github.com/E1i)! - A late review round whose findings all repeat an earlier round on another head no longer queues another answer and stops by the route of the round limit, a note is dropped from a round before the test and a round with one new finding or only notes answers as before; measured read-only on the stored bus, reviews up to 2026-11-06, the rule stops 20 of 219 late changes rounds, on 19 pull requests (30 repeat in full, 10 of them follow an owner amend).

- [#1443](https://github.com/E1i/mikoshi-construct/pull/1443) [`4cc306d`](https://github.com/E1i/mikoshi-construct/commit/4cc306d9d67e41ecb5366bc48cd11f71ae9a6ac3) Thanks [@E1i](https://github.com/E1i)! - The review bar lowers to defects: a test or a generated file outside the touches follows them and is a note to the reviewer, while any other file there, or one on a guarded path, stays a finding; and on a card of risk R3 or R4 a verdict whose findings are all surviving mutations with no behaviour defect is recorded as pass with those findings kept, while R1, R2 and a card whose risk cannot be read keep changes. The review role line states the same bar.

- [#1473](https://github.com/E1i/mikoshi-construct/pull/1473) [`0e1bf78`](https://github.com/E1i/mikoshi-construct/commit/0e1bf78eda56b7a583dd17c052ec053581c8b7a0) Thanks [@E1i](https://github.com/E1i)! - Only a defect of code, tests or the contract makes a review verdict changes: a finding only on the description of the pull request, the changeset or the prose of the card is advice the reviewer repeats in `advice`, and a verdict whose findings are all advice is recorded as pass with them kept. Every review round, the re-review included, diffs the head from the merge-base of main, so a file the head brought in by merging main is no longer read as the card's change.

- [#1596](https://github.com/E1i/mikoshi-construct/pull/1596) [`6a18860`](https://github.com/E1i/mikoshi-construct/commit/6a18860995ce32ad5287ee64b88daba688d6ff6e) Thanks [@E1i](https://github.com/E1i)! - A review session no longer runs out its 20-minute ceiling after it has already decided. The review node reads the verdict file while the session runs, and the moment a valid verdict is written it records it and ends the session and every process under it, background shells included. A session ended at the ceiling with a valid verdict already on disk has that verdict recorded, with no second run. A session ended at the ceiling with no verdict is not leased again on the same key: the task is withdrawn with the reason `review_ceiling`, and one `board.alarm` names the card, the pull request, the head and the window's route (`pnpm bus:review --dry-run <pr>`, then `pnpm bus:request allow-merge` when that run is clean). Any other `review_failed` is still requeued. The review prompt now has the session run the card's witnesses and mutations by the commands the card names, never vitest over a whole test directory, never a run moved to the background, and never a polling loop waiting on one.

- [#1544](https://github.com/E1i/mikoshi-construct/pull/1544) [`228e860`](https://github.com/E1i/mikoshi-construct/commit/228e860d4525912c284efd029e926baf36b1458f) Thanks [@E1i](https://github.com/E1i)! - A review session no longer leaves a process writing into its review tree after the review. While the session runs, the reviewer samples the process table for the session and every process descending from it. When the session ends, the reviewer waits for those processes to exit before it hands the tree back for removal, and a process still alive after the wait gets SIGTERM, then SIGKILL. This closes the `tree_left` case where pnpm wrote `pnpm-lock.yaml` into a review tree a minute after the tree was removed. The Z1 × review cell of the law registry is now a witness, not a gap. Its witness proves both halves of Z1 on the review node: a restart does not signal a live review session, and no descendant of a finished review session is alive when its tree is removed. `contract/factory.json` records the cell and `contract/ratchet.json` drops the `Z1:review` gap row.

- [#1531](https://github.com/E1i/mikoshi-construct/pull/1531) [`448e53b`](https://github.com/E1i/mikoshi-construct/commit/448e53b8968e869fe5c2f05d68369b393a7d9da6) Thanks [@E1i](https://github.com/E1i)! - The supervisor no longer ends a live review session because only its context reading stood still. It now reads three signals: context growth, transcript growth (the spend and subagent readings the heartbeat takes from the transcript), and the session's process pulse. A review is stopped only when two or more of them have stood still past the no-progress line. With a single stale signal the supervisor raises `session.stalled` with the reason and stops nothing. A review the stall line has already ended once on a head is not queued again the same way: the second time, its task is withdrawn as `review_stalled_twice`, and the window gets the reason with the other way to take, a review by slices of the diff.

- [#1422](https://github.com/E1i/mikoshi-construct/pull/1422) [`bf8ca64`](https://github.com/E1i/mikoshi-construct/commit/bf8ca64ecce34c09551ac31288bb7abc7323b8af) Thanks [@E1i](https://github.com/E1i)! - `package.json` is now the one registry of this repository's scripts: `pnpm contract:update` derives the `CONTRIBUTING.md` table's rows and the `scripts` section of `contract/surface.json` from it, and the published manifest gains the `scriptsOutsideTheHarness` field.

- [#1500](https://github.com/E1i/mikoshi-construct/pull/1500) [`95f3e3f`](https://github.com/E1i/mikoshi-construct/commit/95f3e3fe59e15042e01285cc717ceac997db1d30) Thanks [@E1i](https://github.com/E1i)! - The answer node no longer drops an answer silently. Before, an answer that found a live session in the card tree was withdrawn as held for the owner, and nothing queued it again when that session ended. Now it waits and is checked again every five minutes, with no failure counted, and it runs once the session is gone. An answer leased for a review head that the pull request has since moved past is now superseded before any session runs. It writes no answer and spends no review round.

- [#1490](https://github.com/E1i/mikoshi-construct/pull/1490) [`eb587cb`](https://github.com/E1i/mikoshi-construct/commit/eb587cb81ec5b0c8d946a2ba6f5a8fb46d9428e6) Thanks [@E1i](https://github.com/E1i)! - The supervision of silent sessions now covers spend and review. A card or answer session whose Eddies journal records a session-spend stop is stopped by `bus:run`, with a `session.stalled` event whose reason names the spend and the limit. A review session that records no new step and no context growth for 8 minutes is ended at that point, not at its 20-minute ceiling; a live heartbeat alone does not count as progress. On a code restart a review worker that holds a lease finishes its rounds and exits, while the new worker takes the queued reviews in the free review slots. A test now drives a bus tick built by `composeBusTick` through the silent-session check. A card stopped by fault whose tree holds uncommitted changes now has a way back: `pnpm bus:request requeue --task <task_key> --keep-tree` queues its launch again and the session starts on that tree as it stands; without `--keep-tree` the refusal names this option.

- [#1538](https://github.com/E1i/mikoshi-construct/pull/1538) [`3393ca6`](https://github.com/E1i/mikoshi-construct/commit/3393ca67e48cfa788baba0f3a3579d944d0cd48a) Thanks [@E1i](https://github.com/E1i)! - `intake --move` of a sliced stub now re-points the cards that wait on the dropped card: every open admitted card whose depends name it gets a `card.admitted` with source `amend` that depends on the slices naming it in their blocks instead. A dependent that no slice names makes the drop refused, naming each such card, and `--dry-run` prints the re-pointings it would record.

- [#1606](https://github.com/E1i/mikoshi-construct/pull/1606) [`284760c`](https://github.com/E1i/mikoshi-construct/commit/284760c83e4d585dc0d3165707ac696a125d96b5) Thanks [@E1i](https://github.com/E1i)! - `intake --admit` and `--amend` no longer accept an equivalent witness replacement under an owner decision bound to another card. A standing replacement decision now counts only when it is bound to no card or to the card being admitted, as the standing rules for a witness transfer and for created paths already did. Before this, an allowance given for one card let every card replace its witnesses without the owner.

- [#1434](https://github.com/E1i/mikoshi-construct/pull/1434) [`3f08a25`](https://github.com/E1i/mikoshi-construct/commit/3f08a2524c2fe2a55b8d04475fc39112836329db) Thanks [@E1i](https://github.com/E1i)! - `construct sync --apply` and `construct attach --upgrade` now write the installed browser lab exclusion into `.claude/settings.local.json`, as `init` does, even when they have nothing else to write. A tracked or unreadable file is left alone and the command says so, an entry already held is not added twice, and every other byte of the file stays. `attach --upgrade` records what it added, so `construct detach` removes it. A card session in a linked worktree now also takes that one entry from the main checkout's `.claude/settings.local.json`, when the installed script exists.

- [#1435](https://github.com/E1i/mikoshi-construct/pull/1435) [`7256dc3`](https://github.com/E1i/mikoshi-construct/commit/7256dc344e2b53287fa6b3dce1726e1f7aacb596) Thanks [@E1i](https://github.com/E1i)! - `task:start` in a window now refuses before it touches git and names `pnpm bus:request tree.cut --card <N>`, the one way a window gets a tree; the bus's own cuts keep working, even from a bus a window raised. A `git worktree add` that fails removes the branch it created, so a refusal that says nothing was written holds.

- [#1530](https://github.com/E1i/mikoshi-construct/pull/1530) [`5c78cd2`](https://github.com/E1i/mikoshi-construct/commit/5c78cd26abf5fa7f01bcd42a3c3957580a15b85e) Thanks [@E1i](https://github.com/E1i)! - Intake and the witness node now read the paths of a witness command in one place, `src/commands/test-runner.ts`, so they no longer judge the same witness differently. Before, intake read the name after `-t` as a path, so a red-on-main replacement with a slash in its test name went to an owner wait. It also ignored the path in `--dir=foo/bar`. Both now read a `-t` name as no path and a `--flag=path` value as the path it holds, the way the witness node already did.

- [#1551](https://github.com/E1i/mikoshi-construct/pull/1551) [`98471a7`](https://github.com/E1i/mikoshi-construct/commit/98471a7687f60e380d59f0c72ba84ce3a1b6f6a9) Thanks [@E1i](https://github.com/E1i)! - The rule that decides which paths a card may change now lives in one factory module that imports nothing from the CLI: which paths a text names, which fall outside the touches, which tests the runs cover, and which files follow the touches. The intake check, the card readers and the bus nodes all read it from there, and the factory manifest list moves with it, so the following table no longer names a manifest file of its own. The card version rises from 1 to 2: every new admission carries `cardVersion` 2, and a node of this build reads a card admitted at version 1 without a new admission.

- [#1540](https://github.com/E1i/mikoshi-construct/pull/1540) [`d6760a4`](https://github.com/E1i/mikoshi-construct/commit/d6760a413a642935daa21e670e858de9fdeee9ce) Thanks [@E1i](https://github.com/E1i)! - A witness that greps a file no longer reads its pattern as a path. Before, `grep -qE '"scripts/(core|intake)/' file` named `scripts/(core|intake)` and a `-e "\"scripts/core/"` pattern named `\"scripts/core`, so intake judged the witness unfit when that "path" was absent and outside the card. A token holding a regex metacharacter, the token after a grep's `-e`, `-E` or `-F` (a `test -e` operand is still a path), and a token that opens with a quote inside a quote are now no path; the file the command reads is still one.

- [#1457](https://github.com/E1i/mikoshi-construct/pull/1457) [`7a57380`](https://github.com/E1i/mikoshi-construct/commit/7a57380d17f292eaa102e68dacbdc205a88bf113) Thanks [@E1i](https://github.com/E1i)! - `review.recorded` carries `rules_version`, the version of the review rules a verdict was given under. The version is `REVIEW_RULES_VERSION` in `scripts/nodes/review/review-executor.ts`, pinned to the rules by `REVIEW_RULES_SHA`, the sha-256 of `.claude/agents/review.md` and the review bar line of the reviewer prompt: a change to either is red until the version is raised and the sha re-recorded. It is not `prompt_sha`, which moves with every card body. A pass carried by a clean update keeps the version of the verdict it carries, and the board shows a counter of open pass verdicts under older rules, a record with no version counting as older. Nothing is withdrawn and no stored event is rewritten.

- [#1599](https://github.com/E1i/mikoshi-construct/pull/1599) [`90757ed`](https://github.com/E1i/mikoshi-construct/commit/90757edc8d97292e76c0af128adaf897ec3a3580) Thanks [@E1i](https://github.com/E1i)! - cli: an answer stop on paths outside a card's touches now asks to widen only to files the card's tree actually changed. A word in the session's question that looks like a path, such as an event name, or a file the card never changed no longer opens a widening wait. That wait used to stop the next answer round before any session ran.

- [#1476](https://github.com/E1i/mikoshi-construct/pull/1476) [`5cb85a7`](https://github.com/E1i/mikoshi-construct/commit/5cb85a791a1ddf2ec9a3abb62222838f52e3a0d1) Thanks [@E1i](https://github.com/E1i)! - The pre-push gate (`scripts/ci/prepush.ts`) and the window gate (`scripts/ci/select.ts --window`) now diff from the last main commit with green CI in the branch's history, read through the CI port. When that cannot be read, they diff from the merge-base with `origin/main` and say why. The pre-push gate no longer runs the full suite locally: a change that would select the full suite runs only the tests each changed path reaches, and the green line says the full run belongs to CI. A failed test whose name declares a capability (`[needs net-listen]`, `[needs ps]`, `[needs miko-session]`) that the sandbox lacks is reported as sandbox norm, separately from real failures. A pre-push run whose only failures are sandbox norm is green and does not ask for another run.

- [#1418](https://github.com/E1i/mikoshi-construct/pull/1418) [`b560a83`](https://github.com/E1i/mikoshi-construct/commit/b560a83af217b6c979aa889efe704fb96bd8765d) Thanks [@E1i](https://github.com/E1i)! - A window is now only a session `miko` started: `miko` for the loop, or the new `miko --tab` for a tab window. A bare `claude` or an IDE tab is no window: it writes no window heartbeat, and `handoff:write` and `miko:watch` refuse it and say how to start one. A prompt whose first line names the handoff of another repository is refused, naming the window it belongs to.

- [#1601](https://github.com/E1i/mikoshi-construct/pull/1601) [`d9857fa`](https://github.com/E1i/mikoshi-construct/commit/d9857fadb03d50e93faac3d11df8c9861b4fbecb) Thanks [@E1i](https://github.com/E1i)! - Each kind of window request now runs from its own file under `scripts/window/requests/`, one file for each `REQUEST_KINDS` member (`tree-cut.ts`, `amend.ts`, `owner-wait-close.ts`, `decisions-add.ts`, `owner-stop.ts`, …). `index.ts` holds the dispatcher, `REQUEST_EXECUTORS` keyed by kind, and `dispatchRequest`. `context.ts` holds what several kinds read: an observed pull request, a card's route, its latest turn, writing a decision. `reach.ts` is the only file in the folder that imports from outside the window, so splitting the file adds no boundary import. `window-requests.ts` keeps the public surface: parsing the command line, writing a request, and `WindowRequests`, which answers pending requests through the dispatcher. Behaviour, events and refusal texts are unchanged. The `window-requests` concept's owner exists now (`dispatchRequest`). Its overlaps fall from 18 to 0, and `window-requests.ts` falls from 1013 lines to under the 800-line threshold. `contract/surface.json` no longer lists `settled` among the `bus:request` flags: that was the flag the bus passes to `decisions:add`, and `bus:request` never accepted it.

- [#1449](https://github.com/E1i/mikoshi-construct/pull/1449) [`3e38f87`](https://github.com/E1i/mikoshi-construct/commit/3e38f87ab6c8ee1df03e73858f5f08cccd09faf3) Thanks [@E1i](https://github.com/E1i)! - `pnpm miko` starts the window on a diet: `--setting-sources project,local`, `--strict-mcp-config` with an empty MCP config of its own and `--disallowedTools` for the five schemas the window never calls (Artifact, Workflow, AskUserQuestion, ScheduleWakeup, ReportFindings); card sessions launch as before. `pnpm board --json --live` prints only the live cards, and is the window's start reading of the board. `window-core` points at the section of `window.md` with its line range. `pnpm exec tsx scripts/window/start-context.ts --last` reads the last window's first-turn context and its context at the first `miko:watch` against 45k and 70k.

- [#1590](https://github.com/E1i/mikoshi-construct/pull/1590) [`b82075c`](https://github.com/E1i/mikoshi-construct/commit/b82075cfa835877c4555b329707671999d38c89a) Thanks [@E1i](https://github.com/E1i)! - The window's subagents now reach the board. Each supervisor tick reads `.construct/window-agents.jsonl` and publishes every start and stop as a `window.subagent` event. The event carries the window session and the agent id and is keyed `window.subagent:<session>:<agent id>:<phase>`, so rereading the file or restarting the supervisor writes no duplicate and loses no line. The board removes an agent by its id when that agent stops, and it shows the agent even when the window sends no heartbeat. The subagents line now reads `CRAWLERS <n> · top spend <largest> / <limit> cap` and each pulse reads `pulse <n> min ago`, the same in the lore and plain text. Its arrow comes from the button's `aria-expanded` and rotates when the button toggles, without the rotation animation under `prefers-reduced-motion`. A subagent row turns yellow when its context or spend reaches the warn ratio and red at the limit, using the thresholds and colours of the tile's CTX and SPENT bars. The collapsed line takes the colour of the heaviest subagent.

- [#1441](https://github.com/E1i/mikoshi-construct/pull/1441) [`50d9796`](https://github.com/E1i/mikoshi-construct/commit/50d9796fe5d731ca90f1abcb9dbfc4ab0382b94a) Thanks [@E1i](https://github.com/E1i)! - The witness tells "could not check" from "failed": a browser witness whose declared server never answered now records the verdict `unchecked` instead of red. It queues no answer round, it does not let the pull request merge (the witness denial names it as could not check, not red), the board shows `could not check` apart from red, and the pull request status reads `witness could not check` as pending, not `witness red`, and the window wakes on it as it does on red, and on a green after it; a witness that ran and failed stays red, and events already stored keep their verdict.

- [#1528](https://github.com/E1i/mikoshi-construct/pull/1528) [`e81ea25`](https://github.com/E1i/mikoshi-construct/commit/e81ea253c45fe0cee7cb5b73dbe24cc1c2a72c8b) Thanks [@E1i](https://github.com/E1i)! - The law registry names the hole where a dropped card that was sliced leaves its dependents waiting: the Z4 × intake cell of `scripts/nodes/laws.ts` is now a gap closed by [#1740](https://github.com/E1i/mikoshi-construct/issues/1740), [#1754](https://github.com/E1i/mikoshi-construct/issues/1754) and [#1789](https://github.com/E1i/mikoshi-construct/issues/1789), the card that re-points those dependents onto the slices. `contract/factory.json` records the new card; the gap count in `contract/ratchet.json` is unchanged, since the cell was already a gap.

- [#1534](https://github.com/E1i/mikoshi-construct/pull/1534) [`61d011e`](https://github.com/E1i/mikoshi-construct/commit/61d011e9729213edcc32e7504673a69070a328f2) Thanks [@E1i](https://github.com/E1i)! - The law registry stops counting a review session as witnessed alive when no witness runs the review node. The registry gains the `supervisor` site, `scripts/supervisor/stalled-sessions.ts`, with a cell for every law; its Z7 cell is witnessed by the case [#1792](https://github.com/E1i/mikoshi-construct/issues/1792) settled: a live review session whose only stale signal is the context reading is not sent SIGTERM. A law cell is now green only when its witness calls a function of the site's own module, measured by V8 coverage during the run. Every cell whose witness never called its site, Z7 × review among them, is a gap of [#1814](https://github.com/E1i/mikoshi-construct/issues/1814), law-registry-tells-the-truth, as are the cells that named the merged [#1777](https://github.com/E1i/mikoshi-construct/issues/1777). `contract/factory.json` records the new site and cells, and `contract/ratchet.json` the new gap rows. A gap now holds only while the card it names is open: the law-sites suite rejects a cell whose gap names a merged or closed card, so no cell names [#1777](https://github.com/E1i/mikoshi-construct/issues/1777) or [#1792](https://github.com/E1i/mikoshi-construct/issues/1792). The 32 Z3–Z6 cells that already named merged cards on main ([#1672](https://github.com/E1i/mikoshi-construct/issues/1672), [#1754](https://github.com/E1i/mikoshi-construct/issues/1754), [#1764](https://github.com/E1i/mikoshi-construct/issues/1764), [#1767](https://github.com/E1i/mikoshi-construct/issues/1767)) stay pinned in a list that can only shrink, until a card that the window opens re-points them.

## 0.46.0

### Minor Changes

- [#1400](https://github.com/E1i/mikoshi-construct/pull/1400) [`4ed296a`](https://github.com/E1i/mikoshi-construct/commit/4ed296a708912c731d09c8bcca31fbe345830deb) Thanks [@E1i](https://github.com/E1i)! - The factory and the window now reach the agent client through a Client Adapter, whose contract is in decision record 0060: spawning a session, its process, its identity and the readings of its stream and transcript go through the adapter, and `construct cost` reads session records through one registry of cost sources. Claude Code is the one adapter there is. What each session runs does not change, except what this release's other entries say.

### Patch Changes

- [#1386](https://github.com/E1i/mikoshi-construct/pull/1386) [`6c22f29`](https://github.com/E1i/mikoshi-construct/commit/6c22f2900357d2370cc66ebf32d9c4367d14f618) Thanks [@E1i](https://github.com/E1i)! - An answer session on a red CI now gets the FAIL and Error blocks and the tail of the failed-job log, without ANSI codes, passing test lines or runner setup, under a ceiling of 20000 characters, with a line naming how many characters were cut and the link of the job, instead of the first 100000 characters of the log.

- [#1396](https://github.com/E1i/mikoshi-construct/pull/1396) [`36b823b`](https://github.com/E1i/mikoshi-construct/commit/36b823b25b58515acc9101e7eb0b916fd5c60572) Thanks [@E1i](https://github.com/E1i)! - The window's tile and the handoff dialog read FIXER MIKO, with window · Miko as their tooltip. The board's blocks share one cut form whose frame line runs along the diagonal; the header, the warnings strip, the waits strip and the opening dialog sweep their frame, and reduced motion stops it.

- [#1398](https://github.com/E1i/mikoshi-construct/pull/1398) [`3caea7d`](https://github.com/E1i/mikoshi-construct/commit/3caea7dab5f300d796d77a2eaad157d97e9bdaf4) Thanks [@E1i](https://github.com/E1i)! - A card's runs in the board's dialog read as lanes: a mask heads a lane with the explicit files it covers inside, a file no mask covers sits in a lane headed by its folder, a lane prints file names alone, and a mask with no explicit file is one line reading вся папка. A layer heads its lanes, and the reason of a full run stays above them.

- [#1391](https://github.com/E1i/mikoshi-construct/pull/1391) [`a81a90d`](https://github.com/E1i/mikoshi-construct/commit/a81a90dbc1aa35dcbbc2c7492bfc7e3c5d42d57d) Thanks [@E1i](https://github.com/E1i)! - The board draws one tile per session: a session that replaced another of the same card and role draws no second tile, each tile reads the gauges of its own session id, and agents at work counts sessions. The card dialog scrolls one area under a fixed head.

- [#1395](https://github.com/E1i/mikoshi-construct/pull/1395) [`af8dbf5`](https://github.com/E1i/mikoshi-construct/commit/af8dbf56f49ed9ccd7f28decb683b7ccd230652b) Thanks [@E1i](https://github.com/E1i)! - A session with subagents gets a line under its tile, with the count and the largest spend against `agentSpend`, which opens a list in place without opening the card, stays open across a refresh and turns red at `warnRatio` × `agentSpend`.

- [#1355](https://github.com/E1i/mikoshi-construct/pull/1355) [`42a0135`](https://github.com/E1i/mikoshi-construct/commit/42a0135a1a61bc8268aa043859bcbc1564213817) Thanks [@E1i](https://github.com/E1i)! - A card session of the bus now runs the browser lab outside the sandbox only as `node <home>/.construct/browser-lab/bin/browser-lab.mjs`, an absolute path outside the tree that the bus installs from the factory, and only when the repository excludes that command; a copy of the script in the tree stays in the sandbox. `construct init` writes the entry into `.claude/settings.local.json` on the machine instead of the committed settings, `construct attach` writes the same absolute entry, and the lab takes its tools only from `~/.construct/browser-lab/npm-cache`, ending as unobserved when a pinned tool is missing there. A repository attached earlier needs `construct detach` and `construct attach` to replace its recorded relative entry.

- [#1381](https://github.com/E1i/mikoshi-construct/pull/1381) [`f1ba51a`](https://github.com/E1i/mikoshi-construct/commit/f1ba51adadc30702e528fcd362c1f92a585fd4e1) Thanks [@E1i](https://github.com/E1i)! - A card is amended with no file: `pnpm bus:request amend --card <N>` adds and removes witnesses and touches, appends the owner's words verbatim and changes depends, the bus edits the body, recomputes its risk and runs, runs the lane check and keeps the card in its lane. `construct-intake --amend` recomputes the risk and runs the same way, and `--touches` and `--creates` take `+a,+b`, `+a +b` and the repeated flag alike, so no form drops a path.

- [#1364](https://github.com/E1i/mikoshi-construct/pull/1364) [`2c9c7e3`](https://github.com/E1i/mikoshi-construct/commit/2c9c7e394e4c66b9eb34b3a845bc06156c0b0ed9) Thanks [@E1i](https://github.com/E1i)! - `intake --move <#N> --to later` now writes `card.deferred` instead of `card.dropped`: the card keeps its number and depends, takes no lane position and does not start, a card that depends on it keeps waiting, and a move to a launch lane returns it to the queue with no new intake. The board's warning about a planned, startable card and a new line in the launch node's log state the same reason: the card at the head of the lane, `overlap with open PR #N on <path>`, or occupied slots.

- [#1357](https://github.com/E1i/mikoshi-construct/pull/1357) [`32fb5c9`](https://github.com/E1i/mikoshi-construct/commit/32fb5c904e5f46003bf58b423a5c073fc4bb8ea0) Thanks [@E1i](https://github.com/E1i)! - `construct cost` reads session records through one registry of cost sources in `src/commands/cost/source.ts`; its output does not change.

- [#1389](https://github.com/E1i/mikoshi-construct/pull/1389) [`5c8a378`](https://github.com/E1i/mikoshi-construct/commit/5c8a3789f1c1e3bfe67138ac86d88ab90423287d) Thanks [@E1i](https://github.com/E1i)! - The bus now reads a session's stream and transcript through one reading in the client adapter; its events, usage, cost, turns, model, denials and session identity keep their values, and what the client does not report reads null. One thing a user can see: the answer node now looks for a session's transcript under `CLAUDE_CONFIG_DIR` when it is set, as the launch node already did, where it looked only in the home directory, so an answer session resumes there instead of starting fresh.

- [#1358](https://github.com/E1i/mikoshi-construct/pull/1358) [`ee02246`](https://github.com/E1i/mikoshi-construct/commit/ee022466d4e80bdd42e9a74791eee6fb183df70c) Thanks [@E1i](https://github.com/E1i)! - The factory's launch, answer, review, ladder and resume sessions now take their command, arguments and client environment from the client adapter instead of naming the client binary themselves. What each session runs does not change.

- [#1367](https://github.com/E1i/mikoshi-construct/pull/1367) [`b690918`](https://github.com/E1i/mikoshi-construct/commit/b6909180660d4f5572e4a9c863d49685597bea32) Thanks [@E1i](https://github.com/E1i)! - The window's command, including `$MIKO_CLAUDE` and `dontAsk`, its transcript readings and the sandbox directory of the quality lock now come from the client adapter instead of being named in the window's own files. What the window runs and reads does not change.

- [#1369](https://github.com/E1i/mikoshi-construct/pull/1369) [`6123e49`](https://github.com/E1i/mikoshi-construct/commit/6123e49b05ae9262652421b57988dacb13129fcd) Thanks [@E1i](https://github.com/E1i)! - The bus continues a card in its held tree when the changed paths came from the session's own commands (`lint:fix`, a copied template, a generator), not only from its Write and Edit calls; a change made after the session ended or outside every command it ran is still refused.

- [#1373](https://github.com/E1i/mikoshi-construct/pull/1373) [`1665469`](https://github.com/E1i/mikoshi-construct/commit/16654693ad37654866f6f62fc15e8a97e0531860) Thanks [@E1i](https://github.com/E1i)! - A card's second continuation is no longer refused over paths an earlier continued session wrote: the ownership check now counts every session that held the tree.

- [#1388](https://github.com/E1i/mikoshi-construct/pull/1388) [`789af0e`](https://github.com/E1i/mikoshi-construct/commit/789af0ebebc63a0672dc904a98f92a1f3e61970e) Thanks [@E1i](https://github.com/E1i)! - Owner decisions now live in the bus: the `decisions` table holds each decision's card, term, what it supersedes and its state, in force or archived, and `owner-decisions.md` with its archive is a projection the bus rebuilds. A decision leaves force with no manual step when its card merges or closes and when its term ends, in any factory, with no D-54 in the journal. `pnpm decisions:add` always queues a bus request, a card session sees only its own decisions and the general ones, and no decision is refused for its size any more.

- [#1375](https://github.com/E1i/mikoshi-construct/pull/1375) [`9ee9ccf`](https://github.com/E1i/mikoshi-construct/commit/9ee9ccfcaf19360a0b212a4cb193534b8831856b) Thanks [@E1i](https://github.com/E1i)! - The Bash guards refuse a command that prints the whole environment: bare `env`, `printenv`, `set`, `export`, `export -p`, and any word naming `/proc/<anything>/environ`. Check a variable with `test -n "$VAR"`. An init repository gets the refusal through `scripts/construct/eddies.mjs`, an attached repository through `.construct/commit-guard.mjs`; an older install has it after `construct sync`.

- [#1370](https://github.com/E1i/mikoshi-construct/pull/1370) [`43e3b1c`](https://github.com/E1i/mikoshi-construct/commit/43e3b1c172a91397303fa9f885ec8144e64c8d8f) Thanks [@E1i](https://github.com/E1i)! - `pnpm miko:exit` takes the context line this session crossed, by the hook's `budget-warn` record, as the context stop even after compaction shrank the context, and its refusal prints the context, the line and the source of each.

- [#1372](https://github.com/E1i/mikoshi-construct/pull/1372) [`3d1bc87`](https://github.com/E1i/mikoshi-construct/commit/3d1bc879ac396e5aa7aac0797ea72c446ecf873a) Thanks [@E1i](https://github.com/E1i)! - A factory's next card number follows its own row. `pnpm bus:request numbers.foreign --ids <list>` records card ids that came from another factory's row, and intake and the round-limit recut then number after the highest id not so recorded and the factory's pull requests and issues. A number never lands on a card the bus already holds, and the recorded cards stay as they are. A bus with no such record numbers as it did before.

- [#1399](https://github.com/E1i/mikoshi-construct/pull/1399) [`0b75e3e`](https://github.com/E1i/mikoshi-construct/commit/0b75e3e2866c51afce125bd44c4299a034a5b6b4) Thanks [@E1i](https://github.com/E1i)! - `contract/factory.json` now records the factory's own interface, generated from its code by `pnpm contract:update`: the signatures of every port, the bus events, payload keys, tables and `BUS_VERSION`, the concept-to-owner table, and per concept the files that implement it outside its owner with a count. `pnpm contract:overlaps` prints each of those sites as `file:line`, and a test fails when the recorded file differs from the generated one. Intake and the preflight treat the file as generated, as they treat `contract/surface.json`.

- [#1384](https://github.com/E1i/mikoshi-construct/pull/1384) [`bc42b88`](https://github.com/E1i/mikoshi-construct/commit/bc42b88b93406efdc6f812f83cb1a361700a32c4) Thanks [@E1i](https://github.com/E1i)! - A card under `card.held`, a takeover included, now stays out of the launch candidates, its pull request is denied by the merge node as held, naming the hold's reason, and a session of it that exits at a boundary is neither continued nor restarted, until `card.released`; all of them go on after it with no new request. A continuation now waits while an admission of the card has not folded, and then runs on the new body.

- [#1385](https://github.com/E1i/mikoshi-construct/pull/1385) [`fc7b07b`](https://github.com/E1i/mikoshi-construct/commit/fc7b07b63d1edc2d9581d2b79cd64c3d125d5a21) Thanks [@E1i](https://github.com/E1i)! - The intake skill names `construct-intake --amend` and `pnpm bus:request amend` as the way to edit an admitted card and points at their two `docs/cli.md` sections; export, draft and admit stay for an edit those two do not cover.

- [#1359](https://github.com/E1i/mikoshi-construct/pull/1359) [`e76cff2`](https://github.com/E1i/mikoshi-construct/commit/e76cff20ed672f67d05b83ab2150b2bd764e4212) Thanks [@E1i](https://github.com/E1i)! - A not-started `who: window` card no longer chains or binds another card into its lane and does not count as occupying one, and the board warns about a planned, startable card that has not started for 15 minutes, naming the card that holds it.

- [#1397](https://github.com/E1i/mikoshi-construct/pull/1397) [`80228c2`](https://github.com/E1i/mikoshi-construct/commit/80228c2e6de78072ef667a8da9afbbbec4166211) Thanks [@E1i](https://github.com/E1i)! - A machine-wide limit on live launch, answer and review sessions is read before any session of any bus starts, with no limit while no value is set; a card moved into a lane numbered above `lanes` waits instead of starting; and the worker budget counts the runs of every queue directory on the machine, review sessions included.

- [#1365](https://github.com/E1i/mikoshi-construct/pull/1365) [`702a3af`](https://github.com/E1i/mikoshi-construct/commit/702a3afca1c1cb2887c6d186f3fb5e8d232de96e) Thanks [@E1i](https://github.com/E1i)! - `construct cost` counts a card with a pull request from its merge, so merged cards no longer drop out of its figures when no `card.closed` was written.

- [#1374](https://github.com/E1i/mikoshi-construct/pull/1374) [`c4421f9`](https://github.com/E1i/mikoshi-construct/commit/c4421f953347c7d5608b23db6f27dccbb9bf88dd) Thanks [@E1i](https://github.com/E1i)! - The factory board no longer shows a merged card as in work or blocked after a late `card.stopped`, and `construct cost`, the card chain and `release:evidence` find a merge whose `pr.closed` event names no card through its pull request.

- [#1383](https://github.com/E1i/mikoshi-construct/pull/1383) [`fcde60f`](https://github.com/E1i/mikoshi-construct/commit/fcde60fb25b209046b46460dd5ed763a60a4d8e6) Thanks [@E1i](https://github.com/E1i)! - The bus now merges a fresh `origin/main` into a card branch itself and takes every owner path main changed from main byte for byte, so a card session is only ever handed a merge already in progress with conflicts in its own files, and never has to write an owner path.

- [#1392](https://github.com/E1i/mikoshi-construct/pull/1392) [`3d3fe0f`](https://github.com/E1i/mikoshi-construct/commit/3d3fe0fc4ceeb8c00dd233949d2f6fd7d91cb4f8) Thanks [@E1i](https://github.com/E1i)! - `task:close` now closes an implement card with no pull request in the bus by `--report`, as done with the report path, the way a probe closes, so a card whose order ended in a report no longer has to be moved to dropped. An implement card with a pull request still closes with `--pr` only, and `--pr` and `--report` together stay refused.

- [#1366](https://github.com/E1i/mikoshi-construct/pull/1366) [`04d3dee`](https://github.com/E1i/mikoshi-construct/commit/04d3dee38d136f0323429e22bad8c2025c18bc19) Thanks [@E1i](https://github.com/E1i)! - A card's `runs` field now also takes `layer:<id>`, a layer of `scripts/core/layer-map.json` that stands for the tests of that layer: an id the map does not hold is refused, and a card with no `layer:` entry parses as before.

- [#1382](https://github.com/E1i/mikoshi-construct/pull/1382) [`bdf156d`](https://github.com/E1i/mikoshi-construct/commit/bdf156d9f5974b61add5303cca8ae2c38a3fd049) Thanks [@E1i](https://github.com/E1i)! - The pre-push selection and the by-layers merge policy now read a card's runs from the same source as the session: a masked layer only adds to what the changed paths select, a new file resolves through the layer map by folder and one in an unknown folder is a full run that names it, a file in two layers takes both, and a touch no explicit run covers adds its layers.

- [#1376](https://github.com/E1i/mikoshi-construct/pull/1376) [`033024e`](https://github.com/E1i/mikoshi-construct/commit/033024e39c900c423586cec81802b4230ba3effc) Thanks [@E1i](https://github.com/E1i)! - The shift gate and the review now read a card's runs from the check catalog: a test of a layer the card masks, or of a layer its touches reach when it names no runs, counts as a run of the card. When the catalog cannot answer, only the paths the card names count, and a refusal or a review finding says why.

- [#1380](https://github.com/E1i/mikoshi-construct/pull/1380) [`6489156`](https://github.com/E1i/mikoshi-construct/commit/6489156a2ed5da0b7623834c5ecc7d029f87e6bf) Thanks [@E1i](https://github.com/E1i)! - A session the bus starts takes a named list of environment variables instead of the bus's whole environment: `PATH`, `HOME`, `TMPDIR`, `LANG`, `PNPM_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, the proxy variables, `USER`, `LOGNAME`, `SHELL`, `TERM`, `GH_TOKEN`, `NODE_EXTRA_CA_CERTS`, and anything starting with `CONSTRUCT_`, `CLAUDE_`, `ANTHROPIC_` or `LC_`. Anything else set in the bus's environment no longer reaches a card, answer, review or ladder session; a repository whose gate or hooks read such a variable sees it unset there.

- [#1379](https://github.com/E1i/mikoshi-construct/pull/1379) [`fa9a23c`](https://github.com/E1i/mikoshi-construct/commit/fa9a23c79b50ab1c3e914de6380e3cd57b791e44) Thanks [@E1i](https://github.com/E1i)! - The live-session guard now sees a client that runs under its version as its process name, such as `2.1.318`, as well as one named `claude`. A card tree with such a session in it is no longer parked or removed, the answer node holds a card whose tree has one, and the session load reading counts those sessions and says so in `producedBy`. The answer node's own copy of the lookup is gone, so the two readers use one function.

- [#1368](https://github.com/E1i/mikoshi-construct/pull/1368) [`ecc9c57`](https://github.com/E1i/mikoshi-construct/commit/ecc9c575832c2d4a11afde139900d2dd5710d875) Thanks [@E1i](https://github.com/E1i)! - A `shard.decided` from the answer node now carries the decision text, and the session receives that text; a question with no decision text is refused and held for the window instead of coming back to the session unchanged.

- [#1394](https://github.com/E1i/mikoshi-construct/pull/1394) [`2ddb1fd`](https://github.com/E1i/mikoshi-construct/commit/2ddb1fd95205e687f8a813a2c1a4884c15026da2) Thanks [@E1i](https://github.com/E1i)! - The factory's launch, answer and review sessions now start with only the file and shell tools, without the owner's user instructions and auto memory, so a card starts on less context; a card that needs more names it in a `tools:` header line. The launch header sends the session to the card's touches, and `session.heartbeat` reports `start_context` and `read_before_edit`.

- [#1393](https://github.com/E1i/mikoshi-construct/pull/1393) [`35bc5c5`](https://github.com/E1i/mikoshi-construct/commit/35bc5c5a8b09ed278c8b6d8c63d34bad8fe03594) Thanks [@E1i](https://github.com/E1i)! - `card.started` and `review.recorded` now carry `tree_origin`, `reused` or `cut`.

- [#1377](https://github.com/E1i/mikoshi-construct/pull/1377) [`843598d`](https://github.com/E1i/mikoshi-construct/commit/843598df3e128a7698e5f4796829cb43e0e6a165) Thanks [@E1i](https://github.com/E1i)! - Card and review worktrees are now reused: a closed card's clean tree parks in a small pool beside the card trees and the next card takes it, reset to its base with nothing of the card before it, instead of removing one tree and creating another. A stopped card's tree, a tree with a live session and a dirty tree never enter the pool. Installs hardlink from the shared pnpm store, the card tree home carries a Spotlight marker, and `scripts/window/session-load.ts` prints sys CPU, syspolicyd and fseventsd percent, and node per session as one reading.

## 0.45.4

### Patch Changes

- [#1351](https://github.com/E1i/mikoshi-construct/pull/1351) [`0c3f1a5`](https://github.com/E1i/mikoshi-construct/commit/0c3f1a5e8119a0164c4a81285dfcf1a7b44295ae) Thanks [@E1i](https://github.com/E1i)! - A launch session that reaches its context line with no valid handoff no longer stops the card. The bus builds a minimal handoff from the tree diff, the card body and the session's last steps, and continues in a fresh session with no push. The restart limit still bounds it, a `question:` in the report still goes to the owner, and a session that also hit its spend stop still stops. The shift header now states the exact handoff form the bus reads.

## 0.45.3

### Patch Changes

- [#1307](https://github.com/E1i/mikoshi-construct/pull/1307) [`a8e290e`](https://github.com/E1i/mikoshi-construct/commit/a8e290ec5c11afff5153653d3e647ed593780f53) Thanks [@E1i](https://github.com/E1i)! - On GitHub Actions `pnpm test` and `pnpm run quality` now name vitest's `default` and `github-actions` reporters explicitly, unless the command names a reporter of its own. Vitest 5.0.0 already defaults to `github-actions` there (`node_modules/vitest/dist/chunks/defaults.D2ip7f-X.js:67`), so annotations do not change today and this does not explain any run that lacked them; the flags keep them if that default changes.

- [#1287](https://github.com/E1i/mikoshi-construct/pull/1287) [`d559466`](https://github.com/E1i/mikoshi-construct/commit/d55946633e42b544b206c316270b908d9825a3fa) Thanks [@E1i](https://github.com/E1i)! - `construct-intake --admit` and `--amend` report ok only once they have read the card's `card.admitted` back from the bus journal, and name its event id on the line after the ok. When the journal holds no event with that card and text, the command refuses with a non-zero exit instead of printing ok.

- [#1313](https://github.com/E1i/mikoshi-construct/pull/1313) [`85c8b0c`](https://github.com/E1i/mikoshi-construct/commit/85c8b0c230a469d028e66a15f7fc47fbe2cc9fdb) Thanks [@E1i](https://github.com/E1i)! - A repository that already has `.claude/settings.json` now gets the scan allowlist: `init` and `sync --apply` add `WebFetch`, `WebSearch` and `mcp__context7` to `permissions.allow` beside the repository's own entries, and a second run changes nothing. `Edit(/**)` and `Write(/**)` are not merged, so write permission in an existing repository stays as it was. A repository without these rules now reads as `update` in `sync`, and a `permissions` or `permissions.allow` of the wrong shape reads as `conflict` and is left byte for byte.

- [#1341](https://github.com/E1i/mikoshi-construct/pull/1341) [`effba13`](https://github.com/E1i/mikoshi-construct/commit/effba139064152ea014340fa73f419a3da187d53) Thanks [@E1i](https://github.com/E1i)! - An amend of a card now also supersedes the answer task leased on the old card body, whose session the bus stops at its next beat, and a lease taken on the old body runs no session. An answer session whose question comes from an old body, or names an owner wait already closed, writes no owner question: the answer goes again, on the new body or with the closed waits of the card in its prompt. The task on the new body waits out the superseded session instead of reading it as a session the owner holds.

- [#1344](https://github.com/E1i/mikoshi-construct/pull/1344) [`14fc084`](https://github.com/E1i/mikoshi-construct/commit/14fc084a5d71836ade15c5bcef0f1d99058d578d) Thanks [@E1i](https://github.com/E1i)! - Every step of an answer round now writes an `answer.step` bus event with its seconds, so a round that stops or is denied keeps its timings instead of losing them with the `card.answered` it never wrote. A step the round never reached carries null seconds. The gate step now also counts a gate command written `pnpm --dir <tree> …`, the form sessions run, which it used to record as no gate at all.

- [#1336](https://github.com/E1i/mikoshi-construct/pull/1336) [`66d42dc`](https://github.com/E1i/mikoshi-construct/commit/66d42dca34d76ce7314b298ba0556cab894f39ba) Thanks [@E1i](https://github.com/E1i)! - cli: `construct attach` takes `--serve "<command>"` and `--serve-url <url>` and records them as `serve` in `.construct/attach.json`, with the default `readyTimeoutMs` of 30000; it still writes no `construct.json`, and one flag without the other fails before anything is written. The bus's witness node reads `serve` from `construct.json` at the head or from the attach record through one reader, so a browser witness runs in an attached repository too; a repository with neither is still refused.

- [#1294](https://github.com/E1i/mikoshi-construct/pull/1294) [`d3378af`](https://github.com/E1i/mikoshi-construct/commit/d3378aff5b69fb8a034650ad096d79b7c27d77a4) Thanks [@E1i](https://github.com/E1i)! - `construct attach --upgrade` rewrites only the attach carriers of an attached repository to the installed version and keeps its `.construct` data, the handoff, the bus and `.claude/settings.local.json`. The attach record now carries `attachedVersion`, and `doctor` on an attached repository prints the attached version and the installed one and says when the carriers are stale; a record from before this field reads as unknown.

- [#1330](https://github.com/E1i/mikoshi-construct/pull/1330) [`28e8c4e`](https://github.com/E1i/mikoshi-construct/commit/28e8c4e3e4b96486654891f17c1d1a13769aa694) Thanks [@E1i](https://github.com/E1i)! - The bus board shows a warnings strip above SERVICES: a live session or window with its context past the Eddies line (red above the limit), open pull requests over the limit the launch gate reads, open owner waits, a card with no movement past the stall threshold, and `BUS_RERUN=by-layers` while main still requires an up-to-date branch through its protection or a ruleset. With nothing to warn about the strip renders nothing. A board older than twice its refresh marks itself STALE instead of bus live.

- [#1298](https://github.com/E1i/mikoshi-construct/pull/1298) [`ca000e7`](https://github.com/E1i/mikoshi-construct/commit/ca000e7cc782ea7720a30c52cc3f482fb9cebe31) Thanks [@E1i](https://github.com/E1i)! - An env change of the bus agent now reaches the running nodes without a manual `pkill`: every detached bus process carries `BUS_RERUN` and `CONSTRUCT_REVIEW_MODEL` on its command line as `--agent-env` stamps, and `bus:bg` stops and restarts, supervisor first, each process stamped otherwise than the values it is handed. A start handed neither variable restarts nothing; set `BUS_RERUN=as-now` to go back. The merge and update nodes each log their rerun mode when they start.

- [#1283](https://github.com/E1i/mikoshi-construct/pull/1283) [`56107c6`](https://github.com/E1i/mikoshi-construct/commit/56107c64467cef051cd2cc2b69bfcba0409c3e38) Thanks [@E1i](https://github.com/E1i)! - The browser lab names the sandbox when Chromium cannot start inside it, with the bare-command rule, instead of a ProcessSingleton line that reads as a profile fault. The browser-lab skill tells the agent to run the bare command from the repository root, with no `cd`, `env` prefix or `&&`.

- [#1328](https://github.com/E1i/mikoshi-construct/pull/1328) [`3979ba6`](https://github.com/E1i/mikoshi-construct/commit/3979ba60e296f54a6db8813c9c44de80c20f07ea) Thanks [@E1i](https://github.com/E1i)! - The browser lab's `page` takes `--viewport <w[xh]>`, `--color-scheme light|dark` and `--press <keys>`, and `hands` runs on a plain site with no `--extension`.

- [#1316](https://github.com/E1i/mikoshi-construct/pull/1316) [`e0a6c91`](https://github.com/E1i/mikoshi-construct/commit/e0a6c911591b1c5f877e59b3fed071b52d09c53e) Thanks [@E1i](https://github.com/E1i)! - The bus installs the browser lab's playwright-core and Chromium before a session starts, so a session never needs the registry, and the witness node starts the server a browser witness needs from the serve field of construct.json, waits for its url, runs the witness and stops it; a browser witness on a local URL in a repository with no serve refuses instead of falling.

- [#1278](https://github.com/E1i/mikoshi-construct/pull/1278) [`4401809`](https://github.com/E1i/mikoshi-construct/commit/44018098efb22c2b0c6a4eccd2ba14ab469aa0ea) Thanks [@E1i](https://github.com/E1i)! - `construct-intake --amend <#N>` edits an admitted card straight in the bus: `--touches` and `--creates` take `+<path>` or `-<path>`, `--note` appends a line, `--witness <old>=<new>` replaces a witness, `--who` sets `shift` or `window`. The body comes from the bus, the result passes the same checks as `--admit` — a weaker witness still waits for the owner — and is recorded as a new `card.admitted` with source `amend`; `--dry-run` writes nothing. No file is written and no card number is read from a file name.

- [#1304](https://github.com/E1i/mikoshi-construct/pull/1304) [`99e28cc`](https://github.com/E1i/mikoshi-construct/commit/99e28cc124e6bbb75525bcc1de008a6cab433c57) Thanks [@E1i](https://github.com/E1i)! - A card can carry its witnesses and runs as fields: `witnesses: [{"id":"W1","run":"…","test":null,"head":"pass","base":"fail","proves":"…"}]` and `runs: […]`. `construct intake` refuses a field witness with no run, reads `head: exit:N` as that exit, admits a narrowed, moved or negated field witness with no owner decision, and asks for a downgrade by card and id (`#N W1`) instead of the witness text. Cards with prose witnesses work as before.

- [#1295](https://github.com/E1i/mikoshi-construct/pull/1295) [`3aafd05`](https://github.com/E1i/mikoshi-construct/commit/3aafd0575d9d7b89ab57759fc187338711311796) Thanks [@E1i](https://github.com/E1i)! - A card's own changeset no longer counts as a change of every layer, so with `BUS_RERUN=by-layers` a merge updates only the open pull requests its other files reach.

- [#1322](https://github.com/E1i/mikoshi-construct/pull/1322) [`bc92ce2`](https://github.com/E1i/mikoshi-construct/commit/bc92ce21b80af47666f3211abc31ec4511967431) Thanks [@E1i](https://github.com/E1i)! - The merge node now rebuilds the check catalog itself from the tree of main after a merge that changes a test or the layer map, and when the catalog is empty; a failed rebuild leaves the catalog as it was and raises a board alarm. A 405 on a merge now keeps GitHub's response text, a head that is not up to date goes to update rather than counting as a fault, and any other 405 still stops the card, now with the text.

- [#1337](https://github.com/E1i/mikoshi-construct/pull/1337) [`d1864d3`](https://github.com/E1i/mikoshi-construct/commit/d1864d363ca02ad3da5b6f1dd1af9c33ed0502c5) Thanks [@E1i](https://github.com/E1i)! - A composition record and the document its `doc` field names now follow a card whose touches reach a path one of that model's nodes names, so a card changing that code no longer stops on an owner question to widen its touches. The fence reads the models as they stand at the base, and every other guarded path still refuses to follow. A pull request carrying a composition record stays R1 for merge policy and review. `yaml` moves from a development dependency to a runtime dependency of the published package, because the factory now reads the composition models.

- [#1311](https://github.com/E1i/mikoshi-construct/pull/1311) [`0e89e00`](https://github.com/E1i/mikoshi-construct/commit/0e89e00773e66f8764eaa758f9197e69367f2071) Thanks [@E1i](https://github.com/E1i)! - An intake correction confirmed with `CONSTRUCT_WINDOW_SHARD` set now records `window under shard <id>` in `card.admitted` and prints the same label, instead of saying a person confirmed it. The `--confirm` token gate is unchanged, and the variable is not set for you: a run without it still records a person.

- [#1286](https://github.com/E1i/mikoshi-construct/pull/1286) [`17a5bfc`](https://github.com/E1i/mikoshi-construct/commit/17a5bfcb401dab75c043a35ecb196e17a303e932) Thanks [@E1i](https://github.com/E1i)! - `miko:exit` now accepts a window-core version change as a stop condition: when a session the `pnpm miko` loop started loaded an older version than `architecture/window-core.md` now carries, it ends with reason `core` given a fresh handoff, and the loop starts the next session on the new core, so the owner no longer has to type `/exit`. A session outside the loop is not stopped by it.

- [#1301](https://github.com/E1i/mikoshi-construct/pull/1301) [`45316f5`](https://github.com/E1i/mikoshi-construct/commit/45316f50906daaa3810e8f1e07e7b6d32c271aa4) Thanks [@E1i](https://github.com/E1i)! - Parallel card sessions now share a CPU budget. Vitest takes its worker limit from the number of live test pools, with a floor of one worker. The pre-push full suite and `pnpm lint` take turns with `pnpm run quality` in one queue, a session with a clean tree and no unpushed commit runs no pre-push check, and the board shows the machine load.

- [#1306](https://github.com/E1i/mikoshi-construct/pull/1306) [`c85e2d9`](https://github.com/E1i/mikoshi-construct/commit/c85e2d970226d56b3a68aeca2d5a0c2dd3b57b2e) Thanks [@E1i](https://github.com/E1i)! - `construct intake` now reads a `creates` entry ending in `/**` as covering every path under it, so a card that creates a new package no longer files its own witness as unclear or a touch under that package as missing.

- [#1312](https://github.com/E1i/mikoshi-construct/pull/1312) [`2e3741b`](https://github.com/E1i/mikoshi-construct/commit/2e3741b54b0e3682c8654eea496ea30b90dd40db) Thanks [@E1i](https://github.com/E1i)! - An owner decision bound to a card now reaches its answer session: the decisions in force that name the card go into the answer source and into the prompt as a block, and a session that stops on the same question after such a decision is denied as a repeat, with no new owner wait and no new stop, and the answer goes again.

- [#1274](https://github.com/E1i/mikoshi-construct/pull/1274) [`9aaacf2`](https://github.com/E1i/mikoshi-construct/commit/9aaacf231dbb70c243cd803389c2bdb78d63c517) Thanks [@E1i](https://github.com/E1i)! - The review node keeps its depth plan when a concurrent fetch of the shared clone moves `origin/main` under it: a fetch that fails with `cannot lock ref` is retried once before the depth is planned, and any other fetch failure still fails as before.

- [#1346](https://github.com/E1i/mikoshi-construct/pull/1346) [`b9e5eb5`](https://github.com/E1i/mikoshi-construct/commit/b9e5eb577a73188b041b1b8446e76c8fc082056f) Thanks [@E1i](https://github.com/E1i)! - `construct intake --admit` addresses a prose witness by its position, as it does a field witness: the wait for a witness downgrade prints `разрешить понижение свидетеля #N W2` instead of the witness sentence. One decision may name several witnesses: `разрешить понижение свидетелей #N W1 W2` allows those it names and leaves the card refused for the rest. A decision naming a prose witness by its text still lifts its wait.

- [#1347](https://github.com/E1i/mikoshi-construct/pull/1347) [`d987d32`](https://github.com/E1i/mikoshi-construct/commit/d987d32920d847b50e2449c6da2a61b7503825bd) Thanks [@E1i](https://github.com/E1i)! - A card with an open witness downgrade wait gets no answer round until the wait closes, and a question asked under that wait stops the card for the owner.

- [#1340](https://github.com/E1i/mikoshi-construct/pull/1340) [`a10d0ce`](https://github.com/E1i/mikoshi-construct/commit/a10d0ce279e3f3189f4ed968d319866e8ddb67ae) Thanks [@E1i](https://github.com/E1i)! - A restart of the bus onto new code no longer ends the card and answer rounds in flight. A worker holding such a lease finishes its round on the code it started with and exits, while a new worker on the new code takes new leases at once within the same slots.

- [#1338](https://github.com/E1i/mikoshi-construct/pull/1338) [`3b7009f`](https://github.com/E1i/mikoshi-construct/commit/3b7009f52b4b6d0840939a796425d8470fd3d79e) Thanks [@E1i](https://github.com/E1i)! - `pnpm bus:request drop --card <N> --reason <text>` drops a card the bus knows that has no admitted body and has not ended, so such a card no longer sits in review for ever raising a stall warning; a card with a body keeps the `pnpm intake --move` route.

- [#1348](https://github.com/E1i/mikoshi-construct/pull/1348) [`832ad1a`](https://github.com/E1i/mikoshi-construct/commit/832ad1afb1e937cbc329cadf6e87791fa88fb4da) Thanks [@E1i](https://github.com/E1i)! - A launch or answer session that reaches the context warn now writes a handoff and stops, and the bus continues the card in a fresh session from that handoff, whatever its `continue` field says, instead of pushing the unfinished work. Past `MAX_RESTARTS` the card stops with no push and says so; a launch report without a valid handoff stops the card the same way. The spend warn keeps its behaviour.

- [#1349](https://github.com/E1i/mikoshi-construct/pull/1349) [`0e8b0ad`](https://github.com/E1i/mikoshi-construct/commit/0e8b0ad16b9389adb2e95615a0987149069cfe43) Thanks [@E1i](https://github.com/E1i)! - A launch or answer session now reaches its context line at 150k, set by `cardContextLine` in `.claude/eddies.json` as an absolute value `warnRatio` does not apply to; with the key absent the line stays `contextLimit` × `warnRatio`. The coordinating window keeps its own line. The board's context reading divides by the real window of the session's model, from `modelWindows` in the same file, and shows no denominator for a model that file does not name.

- [#1329](https://github.com/E1i/mikoshi-construct/pull/1329) [`4de6098`](https://github.com/E1i/mikoshi-construct/commit/4de60987a616b907ccd39fb2aad1e00630ca5ba0) Thanks [@E1i](https://github.com/E1i)! - A user factory follows `gh auth switch` less. `construct-factory` records the GitHub account of the repository in the keep-alive as `CONSTRUCT_GH_ACCOUNT`: the gh account that started it, or the owner of the `origin` remote when that account cannot push there. Every gh call of a node and every card session the launch node starts runs with `GH_TOKEN` from `gh auth token --user <that account>`, and `doctor --factory` warns under `gh-account` when the active gh account is another one, without stopping the factory. A token gh cannot give for the recorded account fails the call and refuses the card, naming the account, rather than running as the active one. Ladder and answer sessions and the git pushes of the nodes still follow the active account. `construct-factory` now spawns `gh`, only as `api user` and `api repos/<slug>`, both read only.

- [#1327](https://github.com/E1i/mikoshi-construct/pull/1327) [`ede5415`](https://github.com/E1i/mikoshi-construct/commit/ede5415c75f1c8d777a6327f7ae16e75adbaf9ef) Thanks [@E1i](https://github.com/E1i)! - cli: A card number now comes from the bus of the factory it is admitted into, for `construct intake` and for the bus's re-cut at the review round limit alike. A factory no longer receives numbers from the shared `~/.construct/parking`, so a second factory's next card follows its own highest number. Cards already numbered are not renumbered.

- [#1324](https://github.com/E1i/mikoshi-construct/pull/1324) [`de15568`](https://github.com/E1i/mikoshi-construct/commit/de15568687c067774f19b9ffc4b98ec6d0af3da7) Thanks [@E1i](https://github.com/E1i)! - Intake's companion files and the touches fence's following files are now one table, and `src/materialize/factory-manifest.ts` follows a card whose touches reach a path the factory manifest lists. The first bus review no longer reports a file that follows the touches as outside them, so a card's own changeset or generated twin stops costing a review finding.

- [#1305](https://github.com/E1i/mikoshi-construct/pull/1305) [`4ab2977`](https://github.com/E1i/mikoshi-construct/commit/4ab297751f77fbb8c21a04ee427c76f1e284432a) Thanks [@E1i](https://github.com/E1i)! - Under a decisions shard `handoff:write` now accepts `STATUS: OWNER` at every boundary the bus keeps from the window's close of a stop: `version-pr`, `npm-stage`, `security-invariants`, `claude-config`, `owner-merges`, `workflows` and `dropped-witness`. A window can hand such a wait to the owner instead of staying on `CONTINUE`. `owner-merged-kind`, `missing-right` and `owner-question` are still refused under the shard.

- [#1281](https://github.com/E1i/mikoshi-construct/pull/1281) [`3fb3eb0`](https://github.com/E1i/mikoshi-construct/commit/3fb3eb0ca7bcfdbea5331f79a9a6966631c07ed3) Thanks [@E1i](https://github.com/E1i)! - Process heartbeats now keep only their latest value per process in a `heartbeats` table of the bus instead of appending a `process.heartbeat` event on every tick, so an idle bus no longer grows its event journal with them and the nodes' scans over events no longer read them. The supervisor's liveness reading, the loop's live-window check and the board's per-queue slot totals (`src/commands/board/bus.ts`, a reader outside the card's touches, widened here) read the table. `scripts/core/events.ts`, `scripts/core/node.ts` and `scripts/supervisor/liveness-sites.ts` needed no edit: the first keeps `process.heartbeat` as the row type, the second beats through `recordProcessHeartbeat`, the third reads no heartbeat. `node.equivalence` stays an event in the journal, a deliberate scope cut: the shadow window counts its ticks and one-sided keys from events, so its rows still grow the journal.

- [#1296](https://github.com/E1i/mikoshi-construct/pull/1296) [`d8d3132`](https://github.com/E1i/mikoshi-construct/commit/d8d3132345355c95c2530f70e7964c9f15ff2adf) Thanks [@E1i](https://github.com/E1i)! - `construct-intake --move` into a launch lane refuses while the bus projection holds an older card body than the latest `card.admitted`, instead of re-admitting that older body and silently reverting an amend. Run it again once the reducer has folded the admission. `--move --dry-run` prints the move and writes nothing: no event in the bus and no file moved.

- [#1277](https://github.com/E1i/mikoshi-construct/pull/1277) [`d983e75`](https://github.com/E1i/mikoshi-construct/commit/d983e752af5a48285e3bcd960a69a1a6b681bbd7) Thanks [@E1i](https://github.com/E1i)! - The browser lab takes `--proxy <url>`, or `CONSTRUCT_LAB_PROXY` from the environment when no flag is given, and sends its own browser through that proxy at every launch, `hands` included, so a site that blocks by IP can be reached through an exit elsewhere.

- [#1317](https://github.com/E1i/mikoshi-construct/pull/1317) [`de564ff`](https://github.com/E1i/mikoshi-construct/commit/de564ff4b14d9d02d7ce2e62316ad31e14afc616) Thanks [@E1i](https://github.com/E1i)! - The browser lab's `page` takes `--for <ms>`: it stays on the page that long after load and only then reads the title, the text and the screenshot, and every line of `console` carries its time in `at`, with the window in `listenedMs`. With `--route` the window defaults to 15 seconds, so a check a page repeats after load is reported beside the first one instead of the first one standing as the verdict; a `page` with no `--route` still reads at load. A `page --route` run now takes 15 seconds longer unless `--for` says otherwise.

- [#1321](https://github.com/E1i/mikoshi-construct/pull/1321) [`3910035`](https://github.com/E1i/mikoshi-construct/commit/3910035c80c00b8d1a8629b40e0a40db5d1a74a8) Thanks [@E1i](https://github.com/E1i)! - A ready card no longer waits behind a not-ready card of its lane when another lane is empty. When a chain of not-started cards holds a card that cannot start, the ready cards that no such card precedes and that overlap no running card or open pull request move to the empty lane as a chain of their own, and the not-ready cards stay; launch's overlap check holds the later card back while the one that moved runs. A not-ready card keeps its parent in the lane, a ready card whose touches overlap a ready card stays with it, and a lane the owner set with a move is not reflowed.

- [#1280](https://github.com/E1i/mikoshi-construct/pull/1280) [`b61f937`](https://github.com/E1i/mikoshi-construct/commit/b61f937b335ae8186c53e191a6b52300e28563f5) Thanks [@E1i](https://github.com/E1i)! - A merge task on a pull request that cannot merge now parks instead of spinning through lease → `policy.denied` → release every few seconds: on a dirty pull request it is denied once and waits for a new head, and under an open owner question it is denied once and is requeued when the question closes. The bus's `mikoshi` status check is written only when the step or state on a head changes, so a repeated lease no longer posts the same status again.

- [#1333](https://github.com/E1i/mikoshi-construct/pull/1333) [`7d642ab`](https://github.com/E1i/mikoshi-construct/commit/7d642abfa41920845b7c0fb399747271800d7796) Thanks [@E1i](https://github.com/E1i)! - The merge queue updates one green pull request at a time: a pull request the bus just updated keeps the turn until it merges, turns red, is parked or 30 minutes pass, and a pull request of documents no test reads merges without an update.

- [#1290](https://github.com/E1i/mikoshi-construct/pull/1290) [`977dbc5`](https://github.com/E1i/mikoshi-construct/commit/977dbc5fe70844a95b5cb4d9170a7af306557a82) Thanks [@E1i](https://github.com/E1i)! - An update task answered `not_behind` now ends as completed instead of failed: it no longer counts toward the failures that stop a card, writes no `card.stopped`, and the update node does not ask GitHub again for the same head. The `policy.denied` that records the answer stays.

- [#1335](https://github.com/E1i/mikoshi-construct/pull/1335) [`0789eea`](https://github.com/E1i/mikoshi-construct/commit/0789eea2b9d2d6305d7382031b96296c430c7181) Thanks [@E1i](https://github.com/E1i)! - `pnpm bus:request plan --op add` on a release that does not exist or is closed is refused with `release <id> is not open` and writes no `card.planned`. Before, it answered done and the reducer then dropped the event, so the card stayed in no release.

- [#1285](https://github.com/E1i/mikoshi-construct/pull/1285) [`d729d17`](https://github.com/E1i/mikoshi-construct/commit/d729d17dc01fc99e527f855e9ad125de8decdd97) Thanks [@E1i](https://github.com/E1i)! - The bus agent has one source: `pnpm bus:agent` renders `dev.mikoshi.bus.plist` from its template with the factory directory and the command that prints the GitHub token, taken from `--factory-dir` and `--token-source` or from `CONSTRUCT_FACTORY_DIR` and `CONSTRUCT_BUS_TOKEN_SOURCE`, and prints a diff against the installed file. Nothing is written without `--apply`, which replaces the file and reloads the agent; a missing value refuses. The agent no longer reads `CONSTRUCT_FACTORY_DIR` from `launchctl setenv`, and it does not start when the token source fails or prints nothing.

- [#1303](https://github.com/E1i/mikoshi-construct/pull/1303) [`a4a992a`](https://github.com/E1i/mikoshi-construct/commit/a4a992a9af1a56764e10ea37bc2b754e8aec166b) Thanks [@E1i](https://github.com/E1i)! - `pnpm bus:request pr.body --pr <N>` appends the code matrix count line from the card's shift report to the pull request description, so a merge denied for the missing line is queued again under the new description. It is refused with the reason named when the report is absent or holds no count line, or when the description already holds one.

- [#1279](https://github.com/E1i/mikoshi-construct/pull/1279) [`cea2ed0`](https://github.com/E1i/mikoshi-construct/commit/cea2ed00193039c5269d8e07bbee8f333115f586) Thanks [@E1i](https://github.com/E1i)! - A pull request opened without a card line in its description is no longer cut off from its card. The bus now records each pull request's head branch in `pr.observed` and `pr.closed`, and when a newly observed pull request names no card, it links it to the one card whose body declares that branch, so review, answer, CI and merge reach the card. A branch that matches no card, or the branches of two cards, leaves the pull request unlinked rather than guessed, and a card line in the description always wins over the branch.

- [#1332](https://github.com/E1i/mikoshi-construct/pull/1332) [`726960c`](https://github.com/E1i/mikoshi-construct/commit/726960c5e4a8dae48f4d1b351aa2d5f7a45f627b) Thanks [@E1i](https://github.com/E1i)! - A parked card's `priority` now takes `p1` and `p2` as well as `p0`, and the shift takes cards in the order p0, p1, p2, then cards with no priority.

- [#1309](https://github.com/E1i/mikoshi-construct/pull/1309) [`25385d4`](https://github.com/E1i/mikoshi-construct/commit/25385d4ce79651bc179a8e58eac128ab4ed3154e) Thanks [@E1i](https://github.com/E1i)! - A card whose session ends with no pull request and a plain question is no longer stopped as a fault. It waits on the question, and it starts again once the owner closes every question it asked. A session that ends with no pull request and no question is still a fault.

- [#1315](https://github.com/E1i/mikoshi-construct/pull/1315) [`9f35cf8`](https://github.com/E1i/mikoshi-construct/commit/9f35cf88c60fcc66f2107424f496599e64859014) Thanks [@E1i](https://github.com/E1i)! - A window's question becomes an owner wait by itself: `pnpm handoff:write` with `STATUS: OWNER` opens one from each `question:` line of the draft unless one with that text is open, and `owner.wait --need merge` is refused for a pull request the merge policy under the live shard leaves to the bus.

- [#1284](https://github.com/E1i/mikoshi-construct/pull/1284) [`26c734d`](https://github.com/E1i/mikoshi-construct/commit/26c734dc074c36b4c6ee062f81db3657da16071d) Thanks [@E1i](https://github.com/E1i)! - A test under `apps/<name>/tests` or `packages/<name>/tests` that imports a touched file now counts as covering it, so intake puts it in the card's runs and a card that changes it opens its pull request instead of stopping outside its touches.

- [#1343](https://github.com/E1i/mikoshi-construct/pull/1343) [`c15d14a`](https://github.com/E1i/mikoshi-construct/commit/c15d14a66d96b4106615a7544f769ea967b7332c) Thanks [@E1i](https://github.com/E1i)! - A card header can name its release with a line `release: <id>` beside `who` and `priority`: a bus-wired `--admit` or `--amend` puts the card in that release with no `--release` flag and no plan request. An id that names no open release, or a `--release` flag that names another one, is refused and nothing is admitted.

- [#1331](https://github.com/E1i/mikoshi-construct/pull/1331) [`b594c38`](https://github.com/E1i/mikoshi-construct/commit/b594c380ab940a3296aa961845129450ea99bc62) Thanks [@E1i](https://github.com/E1i)! - `pnpm bus:request` with `--help` or `-h` anywhere in its arguments prints the usage, exits 0 and leaves the bus untouched. Before, a `--help` after a kind wrote a real request, which the bus then answered.

- [#1302](https://github.com/E1i/mikoshi-construct/pull/1302) [`438c399`](https://github.com/E1i/mikoshi-construct/commit/438c3997755b22ed97c3ad9b01a5b04aadc85e4c) Thanks [@E1i](https://github.com/E1i)! - At the review round limit under an active decisions shard, the bus grants one extra round when the findings keep changing, and allows the merge when every open finding is a surviving mutation, parking those mutations as witnesses in a continuation card.

- [#1345](https://github.com/E1i/mikoshi-construct/pull/1345) [`d0db13c`](https://github.com/E1i/mikoshi-construct/commit/d0db13c6f44168e252b0f2db68b8f3ce0d1e9e38) Thanks [@E1i](https://github.com/E1i)! - intake: `construct intake` writes the tests that cover a card's touches as the `runs:` field, joined with the runs the draft declares, and no longer appends a `Runs:` line to the task; an admitted card with the old line stays valid. The intake skill's draft example shows `witnesses` and `runs` as fields, and says prose is explanation only.

- [#1275](https://github.com/E1i/mikoshi-construct/pull/1275) [`82ab00a`](https://github.com/E1i/mikoshi-construct/commit/82ab00a08a0cc2b1b5e82ee0acec6df1440cb5c3) Thanks [@E1i](https://github.com/E1i)! - The sandbox list in `scripts/ci/sandbox-failing.jsonl` again holds what the session sandbox refuses on main, so a card that touches a selector file is no longer stopped by the pre-push run on paths it does not own. The four suites that install the packed package are listed under a new refusal kind for the npm registry's 403, which the liveness trace now reads in whichever words the session's proxy uses, one run-root test moves to a new refusal kind for `mktemp` under `$TMPDIR`, and the two run-root entries that now pass are gone.

- [#1291](https://github.com/E1i/mikoshi-construct/pull/1291) [`171ffdc`](https://github.com/E1i/mikoshi-construct/commit/171ffdcef9fbe7cbccb8fbb5a403b4196d8a446a) Thanks [@E1i](https://github.com/E1i)! - A fresh `init` allows `WebFetch`, `WebSearch` and `mcp__context7` in `.claude/settings.json`, so the scan role can read documentation under `dontAsk` instead of being refused. A repository that already has `.claude/settings.json` does not get these rules: the merge there takes only hooks and sandbox.

- [#1299](https://github.com/E1i/mikoshi-construct/pull/1299) [`d8d32e3`](https://github.com/E1i/mikoshi-construct/commit/d8d32e30d63b03fc953745a7d1dfbcd73b7e6b31) Thanks [@E1i](https://github.com/E1i)! - The generated contract security test no longer assumes a bearer scheme: every operation under `/v1/admin` and `/v1/me` must name a scheme the contract's own `securitySchemes` defines, whatever its type, and an admin operation must name the `admin` scope where its scheme marks one.

- [#1310](https://github.com/E1i/mikoshi-construct/pull/1310) [`c697ce9`](https://github.com/E1i/mikoshi-construct/commit/c697ce9dd2d2cd77d2285ce8fcda7f4800985fe5) Thanks [@E1i](https://github.com/E1i)! - cli: `construct init` records how the repository brings its server up as `serve: { command, url, readyTimeoutMs }` in `construct.json`, from the preset's default: `pnpm dev` on port 3000 for `node-backend` and `monorepo`, on port 5173 for `node-frontend`, and nothing for `node-library`. A repeated `init` keeps the `serve` the repository declared, and a malformed one is dropped on read.

- [#1339](https://github.com/E1i/mikoshi-construct/pull/1339) [`02fbb81`](https://github.com/E1i/mikoshi-construct/commit/02fbb81837a426237ae3f10365fbf0572081cfbd) Thanks [@E1i](https://github.com/E1i)! - An intake correction a window confirms under an active shard is recorded and printed as `window under shard <id>` instead of a person; a person at a terminal stays `person`, and events already written stay as they are.

- [#1282](https://github.com/E1i/mikoshi-construct/pull/1282) [`44774fe`](https://github.com/E1i/mikoshi-construct/commit/44774fe0f18d97ad5764c51c1b025674bade52a3) Thanks [@E1i](https://github.com/E1i)! - The launch queue no longer runs cards one at a time just because each names the same shared registration file: files a repository lists under `sharedAppendFiles` in `construct.json` (a path, or a prefix ending in `/**`) do not block parallel launch or chain two cards into one lane when both cards name them. An overlap on any file outside that list, or a mask that covers a listed file, still blocks.

- [#1314](https://github.com/E1i/mikoshi-construct/pull/1314) [`6c05d77`](https://github.com/E1i/mikoshi-construct/commit/6c05d77a120d68a83340e8ac6c45f2b2f363ff3b) Thanks [@E1i](https://github.com/E1i)! - Every `question.owner` stop now has a lift on each route. `bus:request owner.wait.close --from answer` closes the wait on the owner's word from the owner channel and lifts the stop that wait was opened with, a stop on a reservation included, because the word is the owner's; another wait of the same card lifts nothing, and without `--from answer` a window close of a reserved stop stays refused. A card amend admitted after the stop lifts it when the amend's note names the stop id or that stop's wait id (`Q<N>`); any other later amend does not. The answer node's stop on a commit refused for changes outside touches now records the refused paths in `widen`, so an amend covering them lifts the stop with no owner wait to open or close, and an answer to a red CI on an open pull request is queued again; a refused owner path records none.

- [#1300](https://github.com/E1i/mikoshi-construct/pull/1300) [`5c82e92`](https://github.com/E1i/mikoshi-construct/commit/5c82e9293fa195d0d0bd44ef956cdaa703ae7bfa) Thanks [@E1i](https://github.com/E1i)! - `construct intake` and `intake --admit` refuse a touch shaped like a package name (`@types/express`), a host (`registry.npmjs.org`) or a route (`/v1/health`) and name the reason, so a card's touches hold only repository paths. A path of that shape that exists in the tree or is listed under `creates` is kept, except a route, which is never a repository path.

- [#1323](https://github.com/E1i/mikoshi-construct/pull/1323) [`737385d`](https://github.com/E1i/mikoshi-construct/commit/737385d48639bbabf519e4098ff945912ce8515f) Thanks [@E1i](https://github.com/E1i)! - The answer node now opens the missing pull request of a card whose session committed and ended without one. An answer that leaves a clean tree with commits ahead of `origin/main`, on a card with no pull request in the bus, runs the same `tree-pr` step the launch node runs and is recorded as `card.answered` with `published: true`, and the card goes to review on the new pull request. A `tree-pr` that opens none leaves the denial `left_nothing` as before; a tree with uncommitted changes and a card that has a pull request are unchanged.

- [#1308](https://github.com/E1i/mikoshi-construct/pull/1308) [`a1f6710`](https://github.com/E1i/mikoshi-construct/commit/a1f6710cbece6da454911c7fa809d2077b3d0022) Thanks [@E1i](https://github.com/E1i)! - factory: a pull request whose diff adds or widens a command outside the sandbox is the owner's under every shard and every decision, by the new authority rule `unsandboxed_command`, whatever file carries it: `excludedCommands`, `allowUnsandboxedCommands` other than `false`, `dangerouslyDisableSandbox`, an import of `child_process` or a bare spawn call, read from the pull request's patches. A file with added lines GitHub gives no patch for is denied as unread. Tests and `*.md` files are not read. It is a text match that closes these forms, not the whole class; `architecture/security-invariants.md` lists what it does not see.

- [#1342](https://github.com/E1i/mikoshi-construct/pull/1342) [`9d25935`](https://github.com/E1i/mikoshi-construct/commit/9d259354fefd594145de6aa948f1b7a9eb66fd5f) Thanks [@E1i](https://github.com/E1i)! - A pull request that holds the update turn and is green and clean now merges without waiting for the hold to expire. A lower pull request the merge queue sends for an update while another holds the turn waits until that hold ends, instead of being leased again every few seconds and keeping the holder out of the queue, which also spends fewer GitHub calls. Its update still comes as soon as the holder merges or loses the turn.

- [#1288](https://github.com/E1i/mikoshi-construct/pull/1288) [`a7b4dbd`](https://github.com/E1i/mikoshi-construct/commit/a7b4dbd7b74fa86b60c37b253b4a247daea72394) Thanks [@E1i](https://github.com/E1i)! - An owner decision scoped to a card now closes that card's open decision and command waits in the same write, and a card amended through `construct-intake` closes the decision waits opened before the amend. A merge wait stays open until its pull request merges.

- [#1293](https://github.com/E1i/mikoshi-construct/pull/1293) [`5a9782a`](https://github.com/E1i/mikoshi-construct/commit/5a9782aa40b48622a566ba66181b5aae215d1560) Thanks [@E1i](https://github.com/E1i)! - This repository's window has a `window-recipes` skill: one table of a card's dead ends, each row the situation, its sign in the bus, the command and who runs it.

- [#1326](https://github.com/E1i/mikoshi-construct/pull/1326) [`d499627`](https://github.com/E1i/mikoshi-construct/commit/d49962763a601fe05cdd6b81ceb011064ea75769) Thanks [@E1i](https://github.com/E1i)! - `construct init` writes a `window-recipes` skill into a generated repository: one table of a card's dead ends, each row the situation, its sign in the bus, the command that repository has and who runs it. A test asks every command in the table for its `--help`.

- [#1292](https://github.com/E1i/mikoshi-construct/pull/1292) [`c8d75c6`](https://github.com/E1i/mikoshi-construct/commit/c8d75c6e8975a5371171cb5390541b56c30d9ae5) Thanks [@E1i](https://github.com/E1i)! - `pnpm bus:request takeover --card <N> --reason <text>` lets the window take the tree of a card the bus has no route for: a `question.owner` stop with no lift, green witnesses with no open pull request, or no answer or launch task for 30 minutes on a card that needs one. It is refused with the reason named while the card has a live task or a running session. An accepted takeover records `card.held` and `card.takeover`, the answer node skips the card, and `release --card <N>` ends it and queues again the answer tasks the hold withdrew.

- [#1318](https://github.com/E1i/mikoshi-construct/pull/1318) [`e9dc0c6`](https://github.com/E1i/mikoshi-construct/commit/e9dc0c633bcd6d608f0376d8bfafdc244c808b2e) Thanks [@E1i](https://github.com/E1i)! - The card dialog on the board shows a table of a card's witnesses when it has fields, one row W1..Wn with its run, test, expected head/base with the last result on the current head and what it proves, and a line for its runs. `pnpm bus:witness-backfill` parses the `Witnesses:` and `Runs:` of existing cards into fields in one event, lists every line it could not parse by card, and changes no card text; a card it did not parse keeps its prose witnesses. The services grid on the board takes a 16rem column.

- [#1334](https://github.com/E1i/mikoshi-construct/pull/1334) [`94d9937`](https://github.com/E1i/mikoshi-construct/commit/94d9937a07bbbfd4913144900a56c71962fb0911) Thanks [@E1i](https://github.com/E1i)! - The CLI reference describes the witness and runs fields of a card: `runs`, and `witnesses` with `id`, `run`, `test`, `head`, `base` and `proves`, and that a decision allowing a downgrade names the witness as `#N W1`.

- [#1289](https://github.com/E1i/mikoshi-construct/pull/1289) [`5993ff9`](https://github.com/E1i/mikoshi-construct/commit/5993ff9c1bab2852dc27609e1a26b0b1d5483700) Thanks [@E1i](https://github.com/E1i)! - The witness node now witnesses two heads at once: its executor no longer blocks the event loop while a witness command runs, and the git fetch and worktree setup of its tasks take turns, so two tasks never run them together.

- [#1320](https://github.com/E1i/mikoshi-construct/pull/1320) [`91441d6`](https://github.com/E1i/mikoshi-construct/commit/91441d6628323fa66fb48a683081a9e0907a4f58) Thanks [@E1i](https://github.com/E1i)! - `construct-intake` no longer creates a bus. Run from a repository or worktree with no bus at the path it resolves, it refuses with exit `1`, creates nothing and assigns no number, and names what to run first: `construct-factory` or `construct attach`, or a bus named in `CONSTRUCT_BUS_DB`. Before, it opened an empty bus there and numbered the card against it. A bus named in `CONSTRUCT_BUS_DB` is still created.

## 0.45.2

### Patch Changes

- [#1254](https://github.com/E1i/mikoshi-construct/pull/1254) [`89aa4d1`](https://github.com/E1i/mikoshi-construct/commit/89aa4d152b7063dc57523bea3ed119057eb9f2d5) Thanks [@E1i](https://github.com/E1i)! - An answer session that leaves nothing — no new commit, no owner question, a clean tree — is now answered again instead of leaving the card standing silently, and the third empty answer in a row stops the card with an owner wait that names the cause.

- [#1272](https://github.com/E1i/mikoshi-construct/pull/1272) [`c470e34`](https://github.com/E1i/mikoshi-construct/commit/c470e34de9e962ac063db6f2a3f00cc9dfd13175) Thanks [@E1i](https://github.com/E1i)! - An answer round now gates only what it changed: the pre-push run takes `--round <head>` and selects tests and lints over the round's own diff from the head it started on, not the whole pull request, and `card.answered` records how long each step of the round took (lease, tree preparation, session start, first turn, gate, push).

- [#1255](https://github.com/E1i/mikoshi-construct/pull/1255) [`6bdd38f`](https://github.com/E1i/mikoshi-construct/commit/6bdd38f0e6d028697c874b89284f3ea5d438a400) Thanks [@E1i](https://github.com/E1i)! - `init` and `sync` write `architecture/decisions/window-allow-merge.md`, and the bus grants the window's allow-merge past the review round limit only while that record in its own repository reads `accepted`, no longer by an owner decision number of this repository.

- [#1269](https://github.com/E1i/mikoshi-construct/pull/1269) [`0332126`](https://github.com/E1i/mikoshi-construct/commit/033212635c074649ca312ede632755fe28784157) Thanks [@E1i](https://github.com/E1i)! - The eddies gauges on the board page no longer break apart in a narrow panel: each gauge is a three-column grid — the label, the bar taking the free space, the reading at its own width — so the bar keeps its length and the reading stays on the gauge's line.

- [#1237](https://github.com/E1i/mikoshi-construct/pull/1237) [`309ccc3`](https://github.com/E1i/mikoshi-construct/commit/309ccc3f88d7c91e2400856aed115556c61b2fd7) Thanks [@E1i](https://github.com/E1i)! - `construct board` now groups each card under the lane the bus launches it in, the latest `lane.assigned`, not the lane it was admitted or moved into, and drops a wait from the owner strip as soon as `owner.wait.closed` is recorded, without waiting for the reducer. An owner wait with need `decision` now closes when its card is merged, as every other wait of an ended card already did.

- [#1256](https://github.com/E1i/mikoshi-construct/pull/1256) [`636fe25`](https://github.com/E1i/mikoshi-construct/commit/636fe256006e8f44b2d6e6bc5253652ad572bac1) Thanks [@E1i](https://github.com/E1i)! - A corrupted bus index no longer crash-loops the bus nodes until the owner repairs `bus.db` by hand. When a node or the supervisor reports `SQLITE_CORRUPT`, the supervisor stops the nodes of its own bus by its process record and a stop flag, and never touches the nodes of another bus. It backs the bus up through the sqlite backup API into `backups/<time>/` with the `max(id)` and `count(*)` of the events. When the events table still reads whole and no `dedupe_key` repeats, it runs `REINDEX events`, `VACUUM` and `pragma integrity_check`, checks that every event of the backup is in place, runs `bus:reduce`, checks every projection watermark is at `max(id)`, and starts the nodes again. A `bus.healed` event records what was broken and what was done, and `construct board` shows it. When the events table itself is broken, or any step is not ok, the nodes stay stopped, the backup is kept, and the owner gets one question. The heal never runs `.recover`, because it can lose events. The supervisor also publishes `bus.snapshot.db` through the backup API on a timer and after each merge, for external tools to read instead of the live bus.

- [#1241](https://github.com/E1i/mikoshi-construct/pull/1241) [`a44c881`](https://github.com/E1i/mikoshi-construct/commit/a44c881d482eba34b8b392596b091eb9c431c611) Thanks [@E1i](https://github.com/E1i)! - A card's pull request in conflict with `main` now goes to the bus update node, which merges `main` into the card's tree. Where the conflicting paths lie outside the card's touches, the node takes `main`'s version, commits the merge and pushes, so the pull request runs CI again. Where a conflict lies inside the card's touches, the node aborts the merge and stops the card with `question.owner`. Before, no node took such a pull request, and only the owner could clear it. If the update node cannot merge, for example because the card's tree is gone or stands mid-merge, it records a `merge_refused` denial, and the answer node takes the conflict as before.

- [#1234](https://github.com/E1i/mikoshi-construct/pull/1234) [`58df0b7`](https://github.com/E1i/mikoshi-construct/commit/58df0b71934bdcf9e47e2c723d199e1be8fd5d89) Thanks [@E1i](https://github.com/E1i)! - `construct doctor --factory` checks two more items. `window-continue` is red until the last `STATUS:` line of the window handoff is `CONTINUE`, and its command names the handoff to rewrite. `card-permissions` is red while `.claude/settings.local.json` carries `permissions.allow`, `permissions.additionalDirectories`, `permissions.defaultMode` or a `sandbox` block, or cannot be read. Card sessions read that file, so those entries widen what a card session may do; keep them in `~/.claude/settings.json`, which card sessions do not read.

- [#1251](https://github.com/E1i/mikoshi-construct/pull/1251) [`289a7af`](https://github.com/E1i/mikoshi-construct/commit/289a7af2edb1a3d54a33e78dce88f208108af1f8) Thanks [@E1i](https://github.com/E1i)! - A merge of bus code to `main` no longer stops new cards from starting while the leases in flight drain. The supervisor now drains only the bus processes that still hold a lease, and the `leases.draining` record names the sha they run on. Every changed process that holds no lease, launch included, restarts on the new code at once and leases new tasks right away. A process is refused a new lease only while it runs code other than the sha the drain restarts onto. `construct board` shows each open drain: the node, the sha it drains, the sha the restart moves onto, and the deadline.

- [#1253](https://github.com/E1i/mikoshi-construct/pull/1253) [`c413c7c`](https://github.com/E1i/mikoshi-construct/commit/c413c7cb4b0aaec586be3f4650c275514d9f620a) Thanks [@E1i](https://github.com/E1i)! - The bus witness node no longer closes a card while someone is still working on it. Before, a card whose witnesses already passed on `main` was closed while its launch session still ran. The session then opened a pull request that the bus refused, so the pull request was never reviewed or merged. Now a green witness on `main` closes the card only when no session is running for it and no pull request of its own is open. A pull request of its own that merged, or that was closed without merging, does not keep the card open. While a session runs or its pull request is open, the green verdict is recorded and the card stays open.

- [#1232](https://github.com/E1i/mikoshi-construct/pull/1232) [`f9df51b`](https://github.com/E1i/mikoshi-construct/commit/f9df51b4597076645fc67f4bbcb5a5375748b244) Thanks [@E1i](https://github.com/E1i)! - `miko exit` now finds the Eddies context threshold when it runs from a shell that does not set `CLAUDE_PROJECT_DIR`: it reads `.claude/eddies.json` of the directory it runs in, not of the installed package. A window under the `pnpm miko` loop that is past the threshold, with a fresh handoff ending `STATUS: CONTINUE`, now exits and is restarted instead of being refused with "not at a stop condition".

- [#1270](https://github.com/E1i/mikoshi-construct/pull/1270) [`e33c2a6`](https://github.com/E1i/mikoshi-construct/commit/e33c2a6eea90d1fbb8b48419c02d02839be837b0) Thanks [@E1i](https://github.com/E1i)! - `intake` no longer chains the cards of one draft by their imports: a depends between two cards of a draft comes only from the draft. Where one card's file imports a file another card changes, the consumer's body carries an `import:` note naming that card instead of a `corrected: depends` line, and the card is not held for confirmation for it.

- [#1235](https://github.com/E1i/mikoshi-construct/pull/1235) [`7fc2e12`](https://github.com/E1i/mikoshi-construct/commit/7fc2e12521923bac46298087ac4c94ff6ffa9b15) Thanks [@E1i](https://github.com/E1i)! - `construct intake --draft` now accepts a `depends` or `blocks` on a card the bus holds, such as one in work or in review, just as `--admit` already did. Before, such a card was marked unclear as "neither a parked card, done nor merged" and parked for the window. A reference to a card that is neither parked nor held by the bus still stays unclear.

- [#1242](https://github.com/E1i/mikoshi-construct/pull/1242) [`c9e12e2`](https://github.com/E1i/mikoshi-construct/commit/c9e12e2e88dc8a25955f621b87f40d96cdbd14ae) Thanks [@E1i](https://github.com/E1i)! - `construct intake --dry-run` is now refused while a bus exists on the machine and this entry cannot reach it, for `--draft` and for `--admit`, with the same line the write prints. Before, the dry run went through without the bus's cards and could print a number the bus already holds. With no bus on the machine the dry run is unchanged.

- [#1252](https://github.com/E1i/mikoshi-construct/pull/1252) [`a54d3c0`](https://github.com/E1i/mikoshi-construct/commit/a54d3c0538434522a3b03d0a97eea5999ba52d05) Thanks [@E1i](https://github.com/E1i)! - `construct intake --admit` no longer holds a negated witness with the inverted exit, or an equivalent replacement under a standing owner decision in force, as a witness downgrade.

- [#1247](https://github.com/E1i/mikoshi-construct/pull/1247) [`f0d6af6`](https://github.com/E1i/mikoshi-construct/commit/f0d6af64954590754fb13f819234a405c8921f72) Thanks [@E1i](https://github.com/E1i)! - The bus answer node no longer takes a card the owner holds, and refuses an answer commit that changes a path outside the card's touches.

- [#1243](https://github.com/E1i/mikoshi-construct/pull/1243) [`d724753`](https://github.com/E1i/mikoshi-construct/commit/d7247539279a422656c757dd2cd613465dc301c3) Thanks [@E1i](https://github.com/E1i)! - `construct intake --admit` takes one owner word for several witness downgrades. The decision must be live and name the card in its card list, and its text must name the card right after the allowance. `разрешить понижение свидетеля <witness> у [#6](https://github.com/E1i/mikoshi-construct/issues/6), [#5](https://github.com/E1i/mikoshi-construct/issues/5) и [#4](https://github.com/E1i/mikoshi-construct/issues/4)` allows that witness on each card it lists. `разрешить понижение свидетелей у #N` allows every witness of each card it lists. A decision that only quotes a witness, or that allows one witness and mentions another, still holds the card.

- [#1230](https://github.com/E1i/mikoshi-construct/pull/1230) [`652c9f9`](https://github.com/E1i/mikoshi-construct/commit/652c9f92d33380dc1ecae341ceb7fa13bc159261) Thanks [@E1i](https://github.com/E1i)! - `construct intake` and the bus witness check now count a path under a card's `creates` as part of the tree a witness reads, and intake marks unclear a witness meant to be red on the base that names no path of the repository or of the card's `creates`.

- [#1268](https://github.com/E1i/mikoshi-construct/pull/1268) [`852148b`](https://github.com/E1i/mikoshi-construct/commit/852148bfa9b18ae62a3f007649e7c85691789644) Thanks [@E1i](https://github.com/E1i)! - The board reads a release as the cards whose release field names it: merged, in work, review and queue, the remainder of unmerged cards, and the gate as the release's exit criterion, open while the remainder holds a card and due once it is empty. Dropped cards of the release show as one dropped line instead of counting toward the total. `pnpm board --plan <release>` prints the release's plan from the bus, grouped by stage, so plan.md is no longer a second list kept by hand.

- [#1266](https://github.com/E1i/mikoshi-construct/pull/1266) [`eadd322`](https://github.com/E1i/mikoshi-construct/commit/eadd322d56dd51e76537bb00720323263afa7a8b) Thanks [@E1i](https://github.com/E1i)! - The bus keeps a card's release as a field of the card: `plan --op add` and `plan --op remove` move one card into or out of a release with one `card.planned` or `card.unplanned` event, `intake --release <id>` puts an admitted card into an open release, a release carries its gate, and `plan --op backfill` moves the cards a release's plan items linked onto the field in one event. `plan --op link` is gone, and no command writes a card into a plan item any more.

- [#1271](https://github.com/E1i/mikoshi-construct/pull/1271) [`850311e`](https://github.com/E1i/mikoshi-construct/commit/850311e38e15511a54473bf8918dd3ced3e86968) Thanks [@E1i](https://github.com/E1i)! - A card stopped with no pull request on an agent question no longer stays down for good when no window is running. The paths it asks to add to its touches keep only real files in its tree. Anything else, such as a package name, a host or a URL path, is dropped and named in the stop. When nothing is left to add, the card starts again once the owner closes its question. A stop that asks for a real path outside its touches still waits for an amend, and the amend starts it again.

- [#1248](https://github.com/E1i/mikoshi-construct/pull/1248) [`bd86eae`](https://github.com/E1i/mikoshi-construct/commit/bd86eae78fa099dd48569635bee7c0a5495d8224) Thanks [@E1i](https://github.com/E1i)! - A pull request at the review round limit can now go on with its fixes. The owner decision `continue-fixes PR #N at <head>` queues an answer task on that head, carrying the review's findings and the card's current body. The next push gets a review, and the pull request merges only after that review passes. A changes review on that push closes the rounds again, so the next step is a new decision. Before, the only answers to the round-limit question were allow-merge, a re-cut or closing the pull request, because the answer queue stayed closed whatever the owner said. The round-limit wait now names `continue-fixes` beside the other choices.

- [#1250](https://github.com/E1i/mikoshi-construct/pull/1250) [`fbff778`](https://github.com/E1i/mikoshi-construct/commit/fbff7780fe496eb662e1f7ff82db38aaab86f1e6) Thanks [@E1i](https://github.com/E1i)! - The `architecture/owner-merges.md` that `construct init` writes now puts the sandbox settings of the bus sessions (`scripts/ports/shift-settings.ts`, `scripts/ports/isolation.ts`) under `security-invariants`, so the owner merges a change to them under every shard. It also says that the owner merges a pull request that changes the table itself, whatever the table says. The bus enforces that last rule on its own, so a pull request is never judged by the row it replaces.

- [#1260](https://github.com/E1i/mikoshi-construct/pull/1260) [`1f94661`](https://github.com/E1i/mikoshi-construct/commit/1f946611ecbfb7cd19786fb7e2427c71e6a6279a) Thanks [@E1i](https://github.com/E1i)! - The bus now installs a card tree's dependencies outside the sandbox (`pnpm install --frozen-lockfile --prefer-offline --ignore-scripts`) before every card session and every answer session, as the reviewer already did before a review.

- [#1249](https://github.com/E1i/mikoshi-construct/pull/1249) [`7ad2cdd`](https://github.com/E1i/mikoshi-construct/commit/7ad2cdd48d08ba996ebaf04ee92126457fd4f77e) Thanks [@E1i](https://github.com/E1i)! - `construct-factory --mode ghost-protocol` issues a `merge+decisions` shard, so under the owner's word the window answers card questions as well as merging.

- [#1263](https://github.com/E1i/mikoshi-construct/pull/1263) [`133bc9a`](https://github.com/E1i/mikoshi-construct/commit/133bc9a12b344e7c1e22267348c962ab71748ca6) Thanks [@E1i](https://github.com/E1i)! - The intake companion module now also names the files that follow a card's touches without a question: a generated twin of a touched file (`contract/surface.json`, `architecture/add-population.md`, `architecture/self-hosting-drift.yaml`, the root copy of a touched template) and a changeset the card adds, never a `.claude`, owner-merges, security or R1 path; `construct intake` itself reads cards as before.

- [#1244](https://github.com/E1i/mikoshi-construct/pull/1244) [`414fcfd`](https://github.com/E1i/mikoshi-construct/commit/414fcfd217889c480f410428f0a9e3149e3c19ce) Thanks [@E1i](https://github.com/E1i)! - `pnpm miko:watch` no longer leaves the window blind after its parent dies. A watch whose parent process is gone (a `pnpm` killed by a Bash timeout) now exits and releases the `--once` cursor, and the cursor lock records its owner beside `miko-watch.db`: a next `--once` that finds the lock held by a watch whose owner is dead waits a few seconds for that watch to let go and takes the cursor over, instead of answering "another consumer already waits". A lock whose owner is alive is still refused at once, never waited for.

- [#1262](https://github.com/E1i/mikoshi-construct/pull/1262) [`54ecd73`](https://github.com/E1i/mikoshi-construct/commit/54ecd73bfeafff001598d46a7d5cdfdaa1996011) Thanks [@E1i](https://github.com/E1i)! - An owner question no longer ends the window's turn: a tab window whose handoff ends `STATUS: OWNER` cannot stop without a live `pnpm miko:watch`, so the question waits on the board while the window keeps settling every other card.

- [#1236](https://github.com/E1i/mikoshi-construct/pull/1236) [`ab8d33a`](https://github.com/E1i/mikoshi-construct/commit/ab8d33a591ad93651a25693d86fe86b6f23c84a6) Thanks [@E1i](https://github.com/E1i)! - `construct intake` no longer marks a vitest witness that names a test but no file as unable to be red on the base, and `intake --admit` counts the same wordings as intake for a witness that must be red on the base. The witness check that runs a card's witnesses on the base and on the head (P7) now reads the paths a witness names, the card's `creates` and the wording of a change witness through the same reader and predicate intake uses.

## 0.45.1

### Patch Changes

- [#1208](https://github.com/E1i/mikoshi-construct/pull/1208) [`8a3d48f`](https://github.com/E1i/mikoshi-construct/commit/8a3d48fb28691559398316a86705c84b1e0ac032) Thanks [@E1i](https://github.com/E1i)! - `construct attach` on a repository whose remote is not on GitHub now says plainly that the factory is unavailable there, and installs the window alone: without the harness, with no required check asked for, and with no factory place created beside it. A repository with no remote, or a remote that is a local path, attaches as before. `--harness none` attaches without a gate on purpose, and the refusal for a required check that cannot be resolved now names it as the other way forward. Gogs, Gitea and GitLab are not adapters yet.

- [#1210](https://github.com/E1i/mikoshi-construct/pull/1210) [`d3580a4`](https://github.com/E1i/mikoshi-construct/commit/d3580a4e1aec47bc96fbba9c09c8fe497262b926) Thanks [@E1i](https://github.com/E1i)! - `construct board` groups the backlog by the parking lane a card was admitted to or moved to with `intake --move`, not by the launch slot the bus gave it. The launch slot is kept apart as `slot-N` and is never named a lane, and empty `lane-1…N` headings are no longer printed. Every wait under "waits for you" now ends with a ready command and who runs it: the owner runs `gh pr merge` for a merge wait and `pnpm decisions:add` for a decision, and the window runs the `pnpm intake` and `pnpm bus:request` commands a wait names. Each open plan shows a text progress bar. When the bus holds live cards but no open plan, the board prints `plan not registered` with the command that registers one, and an empty flow names the command that admits a card. The bus also closes a wait that asked the window to amend a card as soon as that card is admitted again. On `board.html`, the BUS LIVE indicator reads the factory's liveness from the window heartbeat: a fresh heartbeat shows `bus live`, and none or a stale one shows `bus offline` in red. The header version is read when the page is rendered, so it is the version of the construct that runs the board. A service tile's ctx and spent readings wrap below the bar when the tile is narrow, instead of being cut off.

- [#1195](https://github.com/E1i/mikoshi-construct/pull/1195) [`65e5730`](https://github.com/E1i/mikoshi-construct/commit/65e5730b729927f64ba29919b3584e10f76e4085) Thanks [@E1i](https://github.com/E1i)! - `construct intake` and `/plan` set the cheap contour on every card, whatever its risk: the risk reading sets review depth and who merges, never the contour. A card stated as `ladder` stays on the ladder only when its text carries `ladder: owner <where the owner gave the word> — <the reason>`; without both, intake corrects it to cheap and says why.

- [#1217](https://github.com/E1i/mikoshi-construct/pull/1217) [`bed75e2`](https://github.com/E1i/mikoshi-construct/commit/bed75e29e80ba5fac405c21c06a02849310f3be8) Thanks [@E1i](https://github.com/E1i)! - `construct detach` no longer removes silently. Before anything goes it prints what it will take — each daemon run directory under `.construct/daemon`, the factory's directory beside the repository with its handoff, the handoff's archive and the owner decisions, each with its number of paths, and the total — and asks for confirmation. `--yes` prints the same list and removes without asking; without a terminal and without `--yes`, detach removes nothing and exits `1`.

- [#1201](https://github.com/E1i/mikoshi-construct/pull/1201) [`cc16475`](https://github.com/E1i/mikoshi-construct/commit/cc16475504b8813dc382c5990ba5a461a04cffff) Thanks [@E1i](https://github.com/E1i)! - `browser-lab.mjs hands --profile-from` no longer leaves a profile copy behind for good when its session never reaches `close`: the next hands run sweeps every other session's hands copy idle for six hours, and passes over one it cannot remove. `hands … -- close` writes to `console.json` only the console logs its own session made since its `open`, not those an earlier run left in the same evidence directory. A close that fails removes an earlier `console.json`, writes none, reports the failure and keeps the session for another close; a close with no record of its `open` refuses rather than guess which logs are its own.

- [#1214](https://github.com/E1i/mikoshi-construct/pull/1214) [`de137a7`](https://github.com/E1i/mikoshi-construct/commit/de137a7c4c4829bf26b840f24463039b5db3bf16) Thanks [@E1i](https://github.com/E1i)! - The prompt `daemon.workflow` gives each object's agent now says that `hands` runs with its working directory in that object's evidence directory, so a path passed to `hands`, a screenshot or a file to upload, resolves against the evidence directory and not the repository root.

- [#1200](https://github.com/E1i/mikoshi-construct/pull/1200) [`e604b60`](https://github.com/E1i/mikoshi-construct/commit/e604b60ce1c917d44b7189c8c29210775d23e99c) Thanks [@E1i](https://github.com/E1i)! - `npm pack` builds `dist` first, the bus names stray bus processes from another package, a witness refusal carries the command's last output lines, and a card's own changeset no longer forces a full pre-push run.

- [#1204](https://github.com/E1i/mikoshi-construct/pull/1204) [`2e05221`](https://github.com/E1i/mikoshi-construct/commit/2e052216d8f43ba8f5570bfbeb4ba7f3975146b8) Thanks [@E1i](https://github.com/E1i)! - `construct intake` refuses a draft in which two cards carry the same task text, gives every slice it cuts a goal line of its own, and makes a card that imports what another card of the draft changes depend on it. A witness can state its kind as a field, `{ "witness": …, "kind": "acceptance" | "invariant" }`, and the downgrade check reads that field before the phrase "red on main". A draft can name a `plan` whose file sits inside the repository and holds a slice table; every card then names its `item`, and a bus intake opens the plan, adds the items and links the cards. A refusal says how to add the missing table.

- [#1226](https://github.com/E1i/mikoshi-construct/pull/1226) [`8f547f8`](https://github.com/E1i/mikoshi-construct/commit/8f547f8402c3a5d9bfda0f06e1a48fd211ca5678) Thanks [@E1i](https://github.com/E1i)! - `construct intake` no longer slices by risk an XS card, nor a card whose critical side is only a row of `architecture/security-invariants.md` beside the code that changes it: it writes `whole:` with the reason itself and parks one card, with no confirmation to ask for. A `whole:` the draft states is kept as written.

- [#1215](https://github.com/E1i/mikoshi-construct/pull/1215) [`88e78e5`](https://github.com/E1i/mikoshi-construct/commit/88e78e5fa728f777ab62ba53420338cee526b935) Thanks [@E1i](https://github.com/E1i)! - `browser-lab.mjs --route <url-glob> <file>` now answers the matching requests of the extension service worker as well as those of the pages, and every command that opens the lab browser takes it, not only `page`: `sw-eval "fetch(…)" --route …` gets the file back. `hands` refuses `--route`, since its browser is opened by `@playwright/cli`. The lab opens its browser with `serviceWorkers: 'allow'` and without `PLAYWRIGHT_DISABLE_SERVICE_WORKER_NETWORK`, the two switches that would keep service worker requests off the routes.

- [#1216](https://github.com/E1i/mikoshi-construct/pull/1216) [`93a4cfd`](https://github.com/E1i/mikoshi-construct/commit/93a4cfdf89e0512fb20301129bef38bd5b219308) Thanks [@E1i](https://github.com/E1i)! - The bus no longer keeps a card waiting in a lane once every card it was queued behind has merged or been dropped. A card that has not started yet then gets a lane of its own. It goes to a busy lane only when it shares touches with a card already running there, or depends on a card that is still live. Queued cards that wait behind it never pull it back. A card moved with `intake --move` now launches from the lane it was moved to, including a parking lane numbered above the lane count.

- [#1202](https://github.com/E1i/mikoshi-construct/pull/1202) [`355d96e`](https://github.com/E1i/mikoshi-construct/commit/355d96e8ab537c763654347ec6a1980d90dbe1ab) Thanks [@E1i](https://github.com/E1i)! - `construct-factory --mode ghost-protocol` on the owner's word is the only word the factory needs: every worker it switches on runs live, merge, update, close and restart included, and the switch writes the owner decisions `allow-live merge` and `allow-live update` for the shard's term into the bus's decisions file, creating the file on a fresh factory. A closed card no longer holds a lane while close waits in shadow, and a ready pull request no longer waits for a second `construct say allow-live`. The return to window leaves no switched-off worker live, so a worker switched on later in window starts in shadow. While the owner's ghost-protocol shard is active, the merge node no longer opens an owner wait asking for `allow-live merge`; once the shard is revoked or expired it asks again.

- [#1220](https://github.com/E1i/mikoshi-construct/pull/1220) [`6807d9a`](https://github.com/E1i/mikoshi-construct/commit/6807d9ac945d009cf90c28a7151d78afdc620cec) Thanks [@E1i](https://github.com/E1i)! - The bus no longer launches a card behind a card whose pull request is still open. A card with an open pull request keeps its lane and its touches until that pull request is merged or closed, even while it stands stopped on a question or queued again after an amend.

- [#1203](https://github.com/E1i/mikoshi-construct/pull/1203) [`9e03db7`](https://github.com/E1i/mikoshi-construct/commit/9e03db74c95daacdbb33a40409a3a4957b1f7a12) Thanks [@E1i](https://github.com/E1i)! - `init` now writes the files the factory reads: the `brief`, `review` and `scan` agents (the brief agent names the repository's bus handoff and the `/implement` line the approval needs), the `probe` skill, the `/status` and `/attached-discover` commands, a default `architecture/owner-merges.md` with the column «merges under a shard», and a «Who commits» section in `CLAUDE.md`. `init` in a git repository and `attach` create `owner-decisions.md` beside the repository's bus when it is not there, so `decisions:add` no longer refuses on a first decision.

- [#1207](https://github.com/E1i/mikoshi-construct/pull/1207) [`58b0156`](https://github.com/E1i/mikoshi-construct/commit/58b015600d68e4e2cdb02832719a748eb85b2083) Thanks [@E1i](https://github.com/E1i)! - `init` pins `packageManager` to the pnpm on the path only when it is not older than the pnpm mikoshi itself pins (12.4.2); an older or missing pnpm pins 12.4.2. The monorepo preset's catalog no longer carries `@types/express`, `express`, `express-openapi-validator` and `light-my-request` when the sample app is not written, so its lint passes on a repository with no consumer of them. The `.gitignore` `init` writes ignores `.pnpm-store/`.

- [#1218](https://github.com/E1i/mikoshi-construct/pull/1218) [`245390b`](https://github.com/E1i/mikoshi-construct/commit/245390b57c82469dd2dc8ebedbd683d0d00976b9) Thanks [@E1i](https://github.com/E1i)! - The files the mikoshi factory reads in a repository — the `brief`, `review` and `scan` agents, the `probe` skill, `.claude/eddies.json`, `.claude/settings.json`, `architecture/owner-merges.md` and the hook scripts under `scripts/construct/` — are now one list in code, and a test fails when the factory names a file `init` does not carry. `construct sync --apply` brings a repository initialised before them up to date, and now also appends the factory hooks to a `.claude/settings.json` that lacks them, keeping every entry and key already there. `construct doctor` goes red when the construct carried some of them and one is missing, and says to run `construct sync --apply`; a repository whose record holds none of them is not read as run by the factory.

- [#1206](https://github.com/E1i/mikoshi-construct/pull/1206) [`794083c`](https://github.com/E1i/mikoshi-construct/commit/794083c1b94d76e384e0f12401dae0a5fea02cf9) Thanks [@E1i](https://github.com/E1i)! - `init` now writes the budget layer the factory runs on: `.claude/eddies.json` with the session, agent and run limits, and the `eddies` guard and prompt hooks that measure spend against them. It also writes a window heartbeat: `scripts/construct/window-heartbeat.mjs` runs on every tool use and records a `window.heartbeat` carrying the window's context and spend into the repository's bus. The `.claude/settings.json` it writes lets the window edit and write files in its own repository, and asks before an edit of `.claude/settings*.json` or `.claude/eddies.json`. When `init` merges into an existing `.claude/settings.json`, it now adds the browser-lab sandbox exclusion as well as the hooks. `attach` adds a `heartbeat` hook to the self-contained window hooks, which writes the same `window.heartbeat` without the gauges. A bus that is absent, or has no events table yet, is left as the hook found it.

- [#1228](https://github.com/E1i/mikoshi-construct/pull/1228) [`1f2930b`](https://github.com/E1i/mikoshi-construct/commit/1f2930b9751520cd5a22f6240673b1d0dc410664) Thanks [@E1i](https://github.com/E1i)! - A bus-wired `intake --move` into a parking directory now takes the card off the queue: a move into anything other than a launch lane (`lane-*`, `night-*`, or a dated lane with a one-letter suffix such as `2026-10-30-a`) writes `card.dropped`. It used to write `card.moved` and a fresh `card.admitted` instead, so the bus could launch the card and the board showed it as planned. A dated directory with a word suffix, such as `2026-10-30-folded`, counts as parking.

- [#1196](https://github.com/E1i/mikoshi-construct/pull/1196) [`0e08cc1`](https://github.com/E1i/mikoshi-construct/commit/0e08cc1b31df0ae81e7165baf87d6b84731fc463) Thanks [@E1i](https://github.com/E1i)! - A probe closed by its report is a satisfied dependency for the launch node and for `pnpm task:start` alike: both read one predicate, from the probe's `card.verified` on. A card whose goal is already on `main` closes without a pull request once its witnesses pass on `main`.

- [#1193](https://github.com/E1i/mikoshi-construct/pull/1193) [`5d62689`](https://github.com/E1i/mikoshi-construct/commit/5d6268988e058b50d9d9f8cc8098ae0b05ff1c4a) Thanks [@E1i](https://github.com/E1i)! - Intake no longer reads a card that touches only `src/commands/init.ts` as risk R1: what `init` writes goes into the repository it creates, not into someone else's. What `attach`, `sync` or `detach` write into another repository stays R1, including every template group and the `src/materialize` strategies they share with `init`.

- [#1209](https://github.com/E1i/mikoshi-construct/pull/1209) [`5555258`](https://github.com/E1i/mikoshi-construct/commit/5555258fc6c7c5f8eaeeae9e8c2de7bc2bd3ed37) Thanks [@E1i](https://github.com/E1i)! - `construct intake` counts a test that runs ESLint (it constructs `new ESLint(…)` or calls `calculateConfigForFile`) as covering a card that touches the root `eslint.config.*`, so that test goes into the card's runs instead of being missed.

- [#1224](https://github.com/E1i/mikoshi-construct/pull/1224) [`c3ed507`](https://github.com/E1i/mikoshi-construct/commit/c3ed5072939fe55a21888649500ef5ccb1c9b7e1) Thanks [@E1i](https://github.com/E1i)! - Bus card sessions (launch and answer) may bind local ports on localhost, so an attached repository whose gate runs tests that listen on a port passes its gate inside the session sandbox. Outbound network is unchanged, and the session's isolation reads `partial` with `sandbox.network.allowLocalBinding` named.

- [#1222](https://github.com/E1i/mikoshi-construct/pull/1222) [`a91bedb`](https://github.com/E1i/mikoshi-construct/commit/a91bedb116f74c20eda335d25a51e9e98b07baf7) Thanks [@E1i](https://github.com/E1i)! - `construct doctor --factory` says, before the factory starts, whether it will go: for each item it needs — the files it reads, the eddies and heartbeat hooks in `.claude/settings.json`, pnpm pinned at or above the mikoshi floor, `.pnpm-store/` ignored, a fresh window heartbeat on the bus, and `allow-live merge` and `allow-live update` in force — it prints goes or does not go, and under each red item the command that turns it green. It exits `1` while any item is red; `--json` prints the same checklist.

- [#1227](https://github.com/E1i/mikoshi-construct/pull/1227) [`3545e5d`](https://github.com/E1i/mikoshi-construct/commit/3545e5d316fa419ad0f9a67f62a144707c08525f) Thanks [@E1i](https://github.com/E1i)! - Bus card sessions (launch and answer) may listen on the tsx IPC pipe under `/tmp/claude-<uid>/tsx-<uid>`, so an attached repository whose gate runs the tsx CLI passes its gate inside the session sandbox. No other unix socket is allowed and outbound network is unchanged; the session's isolation reads `partial` with `sandbox.network.allowUnixSockets` named.

- [#1197](https://github.com/E1i/mikoshi-construct/pull/1197) [`e0a7837`](https://github.com/E1i/mikoshi-construct/commit/e0a78372b3d5a69c369705f506205aeecd475021) Thanks [@E1i](https://github.com/E1i)! - `pnpm miko:exit` at `STATUS: DONE` no longer ends a window whose owner has not written in it yet: the window waits for the owner's first message and takes its task. A subagent the window stopped with `TaskStop` no longer counts as running, so the exit is not refused for it. A window's heartbeat carries its repository, and a second window in the same repository names the first before it writes its own beat. The card-tree port cuts a tree for a branch that has no card, by the same path it cuts card trees.

## 0.45.0

### Minor Changes

- [#1185](https://github.com/E1i/mikoshi-construct/pull/1185) [`d919925`](https://github.com/E1i/mikoshi-construct/commit/d919925df553e9c035ff9d59bc97681674c36238) Thanks [@E1i](https://github.com/E1i)! - cli: attach and init let the browser organ start inside the Claude Code sandbox by excluding only `node scripts/construct/browser-lab.mjs *`; detach removes what attach added

- [#1184](https://github.com/E1i/mikoshi-construct/pull/1184) [`a5e9cce`](https://github.com/E1i/mikoshi-construct/commit/a5e9cce87aeb394c42ea7eee1c91fe0e5fc48a57) Thanks [@E1i](https://github.com/E1i)! - scripts: an adapter connects to the browser daemon through one file, `.construct/daemon/<name>/adapter.json`, with five fields — `extension` (a directory, optionally a build command), `prepare`, `objects`, `mechanic` and `success` — whose single source of truth is `scripts/construct/daemon-adapter.schema.json`; `node scripts/construct/daemon.mjs check <adapter>` validates an adapter against it and refuses one whose code imports `mikoshi-construct`.

- [#1189](https://github.com/E1i/mikoshi-construct/pull/1189) [`1e50b9c`](https://github.com/E1i/mikoshi-construct/commit/1e50b9ccc324011879ea54362247135d466b17f2) Thanks [@E1i](https://github.com/E1i)! - attach: carries `scripts/construct/daemon.workflow`, `scripts/construct/daemon-run.mjs` and the `daemon` skill, which run an adapter's objects in a real browser lab — a fresh agent per object, at most two at once unless `limit` says otherwise, each on a `--profile-from` copy of the base profile — and leave `.construct/daemon/<run>/<object>/evidence.json` per object; an object whose prepare fails is recorded unobserved and starts no agent. `detach` removes a `.construct/daemon` attach did not find and leaves one that was there; `cost --json` gains a `daemon` key, present when `.construct/daemon` holds evidence, listing each object's run, object, verdict, agent label and the tokens of that agent's transcript (`null` when no transcript carries the label); the text report does not print it.

- [#1186](https://github.com/E1i/mikoshi-construct/pull/1186) [`6440f8d`](https://github.com/E1i/mikoshi-construct/commit/6440f8db27efff8c32b0ff7d44a7a660cd9a0cb6) Thanks [@E1i](https://github.com/E1i)! - The browser lab collects the console of the page and of the content-script world, routes page responses, takes screenshots, runs on a copy of a base profile and hands the browser to a pinned `@playwright/cli`; CI runs its real-browser tests and fails when any is skipped.

### Patch Changes

- [#1190](https://github.com/E1i/mikoshi-construct/pull/1190) [`1833af0`](https://github.com/E1i/mikoshi-construct/commit/1833af0cbe4a8d02b4203c2d31c5b9c329564be1) Thanks [@E1i](https://github.com/E1i)! - cli: when attach refuses a collision where some paths are not recognised, the next step now reads `Move the paths marked not recognised yourself, then run: cd … && rm -- … && npx mikoshi-construct attach …`, a command a shell runs as pasted, instead of a line whose apostrophe left a quote unterminated

- [#1191](https://github.com/E1i/mikoshi-construct/pull/1191) [`48e3c14`](https://github.com/E1i/mikoshi-construct/commit/48e3c1453a39d640e9d69755e7a135f45c73e01f) Thanks [@E1i](https://github.com/E1i)! - cli: the daemon core is now proven in CI by a fixture adapter run through `daemon.workflow` in a real browser — a prepare that substitutes a config file in the lab copy reads `holds`, one that leaves it as shipped reads `false`

- [#1192](https://github.com/E1i/mikoshi-construct/pull/1192) [`8a6d48c`](https://github.com/E1i/mikoshi-construct/commit/8a6d48ca39105e46d6af1b47574c7fad4379e9ce) Thanks [@E1i](https://github.com/E1i)! - The browser lab's `hands` takes `--profile-from` and copies the base profile once per session, runs each object in its own session with the extension config whatever the position of `-s`, works under `--evidence <dir>` so no `.playwright-cli/` lands in the repository root, and on `close` writes the full console stream of its session to `console.json`.

## 0.44.3

### Patch Changes

- [#1183](https://github.com/E1i/mikoshi-construct/pull/1183) [`3f4f9b9`](https://github.com/E1i/mikoshi-construct/commit/3f4f9b9103e2914871eebfe785dfe3370ef695b9) Thanks [@E1i](https://github.com/E1i)! - attach: the window hooks deny a Write, Edit or MultiEdit into the repository's handoff directory and say to write the handoff with `miko handoff write <name> <draft>`.

- [#1181](https://github.com/E1i/mikoshi-construct/pull/1181) [`eb9c5fb`](https://github.com/E1i/mikoshi-construct/commit/eb9c5fbdaf829e9dd3266468634337b89277579f) Thanks [@E1i](https://github.com/E1i)! - cli: the attached window gets `.construct/window-rules.md` as context at every session start, not only after a compaction, and `attach` no longer writes the `Write` rule for the Engram directory, which Claude Code does not apply; `Read` and `Edit` stay.

- [#1180](https://github.com/E1i/mikoshi-construct/pull/1180) [`c93d4a0`](https://github.com/E1i/mikoshi-construct/commit/c93d4a0b1bf0229219ac720058868e8c94891e8c) Thanks [@E1i](https://github.com/E1i)! - window: the handoff check reads `decisions: none` as no decisions file, and `handoff write` accepts `next task: none` with `STATUS: DONE`.

- [#1179](https://github.com/E1i/mikoshi-construct/pull/1179) [`d264f2f`](https://github.com/E1i/mikoshi-construct/commit/d264f2ff087734f49226d4a4a5560f87780f3c8e) Thanks [@E1i](https://github.com/E1i)! - miko: `miko --help` lists the window commands, `handoff write` and `handoff check` among them, one line each, before the product CLI help.

- [#1177](https://github.com/E1i/mikoshi-construct/pull/1177) [`1ddbb4b`](https://github.com/E1i/mikoshi-construct/commit/1ddbb4b1658189447adc100828f4802c26b461fe) Thanks [@E1i](https://github.com/E1i)! - cli: the rerun line `attach` prints after a collision refusal carries the `--required-check` the run was given, so the rerun no longer exits 2 in a repository with no CI job running the harness.

- [#1182](https://github.com/E1i/mikoshi-construct/pull/1182) [`9b99e0e`](https://github.com/E1i/mikoshi-construct/commit/9b99e0e3db2a47572725cd58a4ecaec3f9884746) Thanks [@E1i](https://github.com/E1i)! - window: `miko exit` refuses, naming them, while a subagent the window started is still running or a worktree holds uncommitted changes.

## 0.44.2

### Patch Changes

- [#1173](https://github.com/E1i/mikoshi-construct/pull/1173) [`54c6d83`](https://github.com/E1i/mikoshi-construct/commit/54c6d831abff93db32694b0de41819e2667f1e7c) Thanks [@E1i](https://github.com/E1i)! - `construct attach` adds the Read, Edit and Write allow rules for the repository's own Engram directory to `.claude/settings.local.json`, and `construct detach` removes exactly those.

- [#1174](https://github.com/E1i/mikoshi-construct/pull/1174) [`0d5ea75`](https://github.com/E1i/mikoshi-construct/commit/0d5ea75e7738861441c4ac43602c1f271c22802f) Thanks [@E1i](https://github.com/E1i)! - cli: `attach --harness <cmd>` without `--required-check` takes the CI job whose step runs that command, and refuses with exit 2 when no such job is found.

- [#1175](https://github.com/E1i/mikoshi-construct/pull/1175) [`5fbf366`](https://github.com/E1i/mikoshi-construct/commit/5fbf366d11f1b4e8172d87116b7f3e758c4bc4ae) Thanks [@E1i](https://github.com/E1i)! - The intake skill and the window architecture say the draft is always taken from the bus with `pnpm intake --export '#N'`, never from a parking file.

## 0.44.1

### Patch Changes

- [#1168](https://github.com/E1i/mikoshi-construct/pull/1168) [`4de7138`](https://github.com/E1i/mikoshi-construct/commit/4de7138688deff4e15ac0b8ad2aaed23bad5f5ff) Thanks [@E1i](https://github.com/E1i)! - `attach` now carries `/construct-atlas` and `/attached-discover` as hidden carriers; in an attached repository the interpretation goes only into the Engram under `~/.construct/engram/`, and `detach` removes both carriers.

- [#1169](https://github.com/E1i/mikoshi-construct/pull/1169) [`da911e8`](https://github.com/E1i/mikoshi-construct/commit/da911e846c551d4f1a776a3d51be0ba9dc0b9c91) Thanks [@E1i](https://github.com/E1i)! - cli: attach carries a generic window rules document beside the window hooks and records `push: none`, under which the bus neither commits, pushes nor opens a pull request in that repository.

- [#1166](https://github.com/E1i/mikoshi-construct/pull/1166) [`4b60286`](https://github.com/E1i/mikoshi-construct/commit/4b60286b275795d5369ce69fb5458e092cf55610) Thanks [@E1i](https://github.com/E1i)! - attach records the CI job its harness candidate came from in attach.json, and the bus reads that job as the required check; where the job's check name is not in the workflow (a matrix, an expression in its name, a reusable workflow) attach refuses until `--required-check <name>` names it

- [#1171](https://github.com/E1i/mikoshi-construct/pull/1171) [`430a20d`](https://github.com/E1i/mikoshi-construct/commit/430a20d0a50859cd35513146f9100e67bab8f0e6) Thanks [@E1i](https://github.com/E1i)! - factory: `miko handoff write` and `miko handoff check` resolve a relative handoff name against the repository's handoff directory — `~/.construct/<owner>--<repo>/handoff` in a repository other than mikoshi-construct, `~/.construct/handoff` in a mikoshi-construct checkout, `CONSTRUCT_HANDOFF_DIR` when it is set — and the first handoff in a new repository is created with its directory. Before, `miko handoff write miko.md <draft>` from the root of a fresh repository resolved `miko.md` against the working directory and refused it as not this session's handoff, so the window in a new repository could not write its first handoff.

- [#1167](https://github.com/E1i/mikoshi-construct/pull/1167) [`1aa2295`](https://github.com/E1i/mikoshi-construct/commit/1aa2295d6934e4bbfd1370b7071ed4e890f44fad) Thanks [@E1i](https://github.com/E1i)! - factory: a merge task's key now carries the sha of the pull request body, so a task withdrawn on the body (`decision_unread`, `no_matrix_count_line`) is queued again under a new key once the body is edited, and the `board.alarm` raised for the withdrawal names that task key.

- [#1164](https://github.com/E1i/mikoshi-construct/pull/1164) [`5998af3`](https://github.com/E1i/mikoshi-construct/commit/5998af31dbe4a62b85e8165d782b1e1e01170e14) Thanks [@E1i](https://github.com/E1i)! - factory: the `miko` bin runs the window of the repository it is started in. `miko` with no arguments starts the window loop; `miko watch`, `miko handoff write`, `miko handoff check`, `miko request <kind>` and `miko exit` run the window's commands from the package; every other `miko <command>` is the CLI as before. In a repository other than mikoshi-construct, the handoff lives in `~/.construct/<owner>--<repo>/handoff`, the bus is that repository's own with no fall back to the machine-wide `~/.construct/bus.db`, and the loop's continue prompt names that handoff and the `miko …` commands instead of `pnpm` scripts. Before, `miko` with no arguments printed the CLI usage, and the window could only run inside a mikoshi-construct checkout.

- [#1165](https://github.com/E1i/mikoshi-construct/pull/1165) [`a91845e`](https://github.com/E1i/mikoshi-construct/commit/a91845e9288e6b6f0325b4e1caa69502d7a97c5a) Thanks [@E1i](https://github.com/E1i)! - factory: a red `witness.recorded` now keeps the names of the failed tests and the first lines of their errors, cut at a limit, after the refusal line. Before, a red witness kept only the last line of the output, so which test failed was lost.

## 0.44.0

[0.44.0 — the factory ships in the package (beta)](/release-notes/0.44.0)

## 0.43.0

[0.43.0 — Mikoshi builds the Atlas of any repository](/release-notes/0.43.0)

## 0.42.0

### Minor Changes

- [#591](https://github.com/E1i/mikoshi-construct/pull/591) [`f93df2c`](https://github.com/E1i/mikoshi-construct/commit/f93df2c9c1c14f9a1525ef031bf29d13f3f1c152) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake --admit` amends a card the journal already admitted when its card line, task text or witnesses changed: the card is checked with the parking grammar and gets a new `intake` line with `"source":"amend"`, instead of a report that it is already admitted. Every `intake` line now records `bodySha`, the digest of the card's text below its header; an unchanged admitted card still writes nothing.

- [#579](https://github.com/E1i/mikoshi-construct/pull/579) [`f29f0c7`](https://github.com/E1i/mikoshi-construct/commit/f29f0c7cb4334a747272967d3bbd974c2f6d6b13) Thanks [@E1i](https://github.com/E1i)! - templates: the `/implement` ladder stops with `base moved`, naming both shas, when the HEAD its harness observed after a rung is not the base pinned at preflight, and the implementer is told the base and not to move HEAD, so a run no longer carries on over a base that changed under it.

- [#571](https://github.com/E1i/mikoshi-construct/pull/571) [`d00e91c`](https://github.com/E1i/mikoshi-construct/commit/d00e91cbb966ea6bc24523a839cffdebd0942119) Thanks [@E1i](https://github.com/E1i)! - ledger: a run ledger row may carry `sketch`, the sha of the sketch its run started from or null (`ledger-row/1.2`), copied from the build's handle by step 4 of the implement skill, and `ghosts:expect-sample --sketch` reads it before the Ghost journal.

- [#585](https://github.com/E1i/mikoshi-construct/pull/585) [`5193511`](https://github.com/E1i/mikoshi-construct/commit/519351192a3aa4d32a2b3954881f8477ad6a1985) Thanks [@E1i](https://github.com/E1i)! - cli: `construct mutate judge --card <n>` appends a `mutation-judged` line — card, mutation id, outcome, whether it matched — to `--journal` (default `~/.construct/handoff/ghosts.jsonl`) after a verdict, so a task closed as verified by mutation can be checked against a mutation that ran; without `--card` nothing is written, as before.

- [#598](https://github.com/E1i/mikoshi-construct/pull/598) [`a89b489`](https://github.com/E1i/mikoshi-construct/commit/a89b48948dfe11327370833a3878e47b6cb1cadd) Thanks [@E1i](https://github.com/E1i)! - cli: inside a shift, whose session carries its card in `CONSTRUCT_CARD`, `construct mutate judge --id` without `--card` is refused before the mutated file is touched, and the refusal names the card to pass; `--baseline`, an `--id` run with `--card`, and every run outside a shift are unchanged.

### Patch Changes

- [#595](https://github.com/E1i/mikoshi-construct/pull/595) [`1c039c7`](https://github.com/E1i/mikoshi-construct/commit/1c039c7e36f79dd5ea9d41ea139be3febc37289d) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake` with `--parking` set to a subdirectory of the parking assigns a number no card already holds: the cards parked in the parking root and in every subdirectory of it count as taken, and so does every number an `intake` line in the journal names, not only the files of the `--parking` directory.

- [#589](https://github.com/E1i/mikoshi-construct/pull/589) [`4da69fd`](https://github.com/E1i/mikoshi-construct/commit/4da69fdfd9e1da22f4a95f7c12da8e1bf10be83b) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake` takes an optional `whole: "<reason>"` on a draft card; a card a person kept whole despite its seam keeps the `who` its draft proposed instead of `window`, and the parked card carries `whole: <reason>` under its seam lines. A card with an unclear field still goes to the window.

## 0.41.0

### Minor Changes

- [#570](https://github.com/E1i/mikoshi-construct/pull/570) [`4b53772`](https://github.com/E1i/mikoshi-construct/commit/4b537721e1ea2b99c4a824261d69b7266fd3eeee) Thanks [@E1i](https://github.com/E1i)! - templates: the `browser-lab` skill and `scripts/construct/browser-lab.mjs` are carried by init, sync --apply and attach; the script observes an extension or a page and exits 0 observed, 1 no content script ran, 127 could not observe.

- [#558](https://github.com/E1i/mikoshi-construct/pull/558) [`1106b00`](https://github.com/E1i/mikoshi-construct/commit/1106b002da0528ecff4cbe21516ac561dfca548e) Thanks [@E1i](https://github.com/E1i)! - cli: `construct cost --expect [--effort low|medium|high] [--json]` prints the forecast of the next run from `.construct/runs.jsonl`, the same calculation the ghost launcher uses.

- [#541](https://github.com/E1i/mikoshi-construct/pull/541) [`33d1900`](https://github.com/E1i/mikoshi-construct/commit/33d19008a9a0ba2dc71ca33458113f3d5d9c5ef4) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake --admit <parking>/<id>.md` admits a card parked before intake confirmed cards: it checks the card by facts under its own number, holds a correction until a person confirms it, and writes the card's `intake` line, so `task:start` and the shift take it.

- [#552](https://github.com/E1i/mikoshi-construct/pull/552) [`9dc5192`](https://github.com/E1i/mikoshi-construct/commit/9dc5192627305fb58a49a0c31d02f3c8eccb1ce1) Thanks [@E1i](https://github.com/E1i)! - templates: the intake skill says `construct intake` corrects a `depends` or `blocks` on a task already in main — an implement task whose merge line is in the journal, or a probe closed by its report — instead of on a closed card.

- [#545](https://github.com/E1i/mikoshi-construct/pull/545) [`bc9f30c`](https://github.com/E1i/mikoshi-construct/commit/bc9f30c2f9401fefbe56162e61f4d5ac2d7e3f9f) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake` counts complexity signals in each card — too many touches or areas, the mechanism the task runs on, a generated file with its sources, too many unclear fields — and, when two or more fire, writes the slicing principle, the signals and proposed disjoint slices into the card and holds it for the window.

- [#565](https://github.com/E1i/mikoshi-construct/pull/565) [`b34481a`](https://github.com/E1i/mikoshi-construct/commit/b34481a10df71e73e04550b39240d241e09183f2) Thanks [@E1i](https://github.com/E1i)! - templates: the `/plan` brief skeleton carries an `expect:` line on line 3, the first line `construct cost --expect --effort <class> --plain` prints, so a repository's entry card and `parseExpect` read the forecast from it.

- [#554](https://github.com/E1i/mikoshi-construct/pull/554) [`40a41d3`](https://github.com/E1i/mikoshi-construct/commit/40a41d345d857ae9f1ed23543e9bc4805a37e40a) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake` writes a `risk: R<n>` line into every card, read from its `touches`: R1 for the ladder mechanism, for anything `init`, `attach`, `sync` or `detach` write into another repository and for the security invariants; R4 for documentation, tests, logs and scripts outside the gate. When a card mixes R1 with R3–R4 work and the split signal proposed no slices, intake proposes a risk seam — `seam: risk` and one `slice:` line per side with its level, a generated file kept with its sources and a template with its twin, named capability / delivery when that is the cut — and holds the card for the window. It only proposes; the card line is unchanged.

- [#564](https://github.com/E1i/mikoshi-construct/pull/564) [`642a924`](https://github.com/E1i/mikoshi-construct/commit/642a924356999ddcb9274bd959ed795fe9a3afca) Thanks [@E1i](https://github.com/E1i)! - intake: the complexity seam keeps a generated file with its sources and a template with its twin in one slice; when its slices would still hold R1 together with R3–R4 work it proposes none and the risk seam is offered; a proposed risk seam waits for the same `--confirm` token as corrections. `scripts/ghosts/**` and `scripts/shift/**` read as R2, except the approval and launch gate (`approval.ts`, `hash.ts`, `launch.ts`), which is R1.

### Patch Changes

- [#547](https://github.com/E1i/mikoshi-construct/pull/547) [`2f5f849`](https://github.com/E1i/mikoshi-construct/commit/2f5f849feb0eafd87b60dc97d952fd22fac9900b) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake` keeps a `depends` or `blocks` on a task that is done but not merged and removes it only when a merge line names the task.

- [#567](https://github.com/E1i/mikoshi-construct/pull/567) [`f09f4b6`](https://github.com/E1i/mikoshi-construct/commit/f09f4b638443514a55fe0f37f8ba094aa95f642f) Thanks [@E1i](https://github.com/E1i)! - `construct cost --expect` names what raises a `none` reading: below five counted runs the line adds how many more done runs at that selection it takes, as in `expect: none — n=4 for effort medium; 1 more done run at effort medium raises it`.

- [#543](https://github.com/E1i/mikoshi-construct/pull/543) [`a49775c`](https://github.com/E1i/mikoshi-construct/commit/a49775c80669acd99b3a2c28300eac2202c86346) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake` counts a witness command named by an absolute path to an existing file, such as `/usr/bin/env`, as resolved instead of marking it unclear.

- [#548](https://github.com/E1i/mikoshi-construct/pull/548) [`b06e7cc`](https://github.com/E1i/mikoshi-construct/commit/b06e7cca0c48bb22959d2806623c6fb60bd11dfa) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake` checks every backticked command of a witness, not only the first, and counts an absolute command path as resolved only when it names an executable file.

## 0.40.0

### Minor Changes

- [#518](https://github.com/E1i/mikoshi-construct/pull/518) [`8c20c37`](https://github.com/E1i/mikoshi-construct/commit/8c20c37fdbbfe949b9895a169faccc051c6e6cbf) Thanks [@E1i](https://github.com/E1i)! - templates: the `/implement` skill says `agreedSha256` is the sha256 of the whole agreed text, `Sketch:` line included, and no longer calls it the approved hash. ghosts: the approval hash of a brief leaves out its `Sketch:` line and the approval line stores the approved sketch's full sha, so `pnpm ghosts:launch` starts a sketch rebased onto a newer `origin/main` without a new approval when `git range-diff` shows every commit as `=`, and refuses it with `re-approve` otherwise; an approval written under the earlier rule is refused once with `re-approve`, and the `event:task` journal line gains `approvedSha256`, `approvedSketch` and `rangeDiff`.

- [#520](https://github.com/E1i/mikoshi-construct/pull/520) [`dcbc016`](https://github.com/E1i/mikoshi-construct/commit/dcbc01600e299c22a5b50695fc9a351b8af6767b) Thanks [@E1i](https://github.com/E1i)! - templates: discovery writes an attached repository's high-effort areas to `.construct/high-effort-areas.md` and `/implement` reads them there, instead of from a CLAUDE.md section nobody fills.

- [#524](https://github.com/E1i/mikoshi-construct/pull/524) [`11c6900`](https://github.com/E1i/mikoshi-construct/commit/11c69004c308ab7ee4d284083766511c44d0c4b6) Thanks [@E1i](https://github.com/E1i)! - templates: `construct attach` now writes a second file beside the commit guard, `.construct/shell-parser.mjs`, which holds the guard's reader of the command line, and `construct detach` removes it; the guard imports it inside the checked call, so a missing parser refuses with exit 2, and the refusals are unchanged.

- [#532](https://github.com/E1i/mikoshi-construct/pull/532) [`5a836c7`](https://github.com/E1i/mikoshi-construct/commit/5a836c76cd748357dac2002491ffd44cc9560859) Thanks [@E1i](https://github.com/E1i)! - cli: `construct.model.json` goes to `modelVersion` 4 with stages, nodes and links, versions 1 to 3 still read with the lists empty, and an older build reads version 4 as ahead of it.

- [#514](https://github.com/E1i/mikoshi-construct/pull/514) [`95bf0d2`](https://github.com/E1i/mikoshi-construct/commit/95bf0d21c4f22b946e99eb4af3a74300cd05d1cf) Thanks [@E1i](https://github.com/E1i)! - cli: `init` refuses a repository that `attach` holds — with `.construct/attach.json` present, readable or not, it writes nothing and says to run `construct detach` first.

- [#536](https://github.com/E1i/mikoshi-construct/pull/536) [`b1d96b2`](https://github.com/E1i/mikoshi-construct/commit/b1d96b24b215459aecb6c2170225b108b6a7cfee) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake` parks no card whose corrections a person has not confirmed: it prints them with a token and exits `2`, `--confirm <token>` parks the cards as shown, `--auto-confirm` (off by default) parks them at once, and every parked card gets an `intake` line in `--journal` with its confirmation and corrections.

- [#534](https://github.com/E1i/mikoshi-construct/pull/534) [`433fea5`](https://github.com/E1i/mikoshi-construct/commit/433fea5b0122e6d63936d212fa6213f2ea8f44ff) Thanks [@E1i](https://github.com/E1i)! - `construct intake` checks each card against the repository and the journal and writes every correction into the card as `corrected: <field> — <was> → <now> — <reason>`.

- [#531](https://github.com/E1i/mikoshi-construct/pull/531) [`1cc512b`](https://github.com/E1i/mikoshi-construct/commit/1cc512b4615efce9eeca75e76e6919507d364337) Thanks [@E1i](https://github.com/E1i)! - `construct intake` turns a draft of sliced cards into parking cards: it assigns the next numbers free in the parking and among the pull requests and issues `--taken` lists, writes each card in the parking format, marks every field the retelling left unclear as an `unclear:` line and keeps such a card with `who: window`, and parses every card back with the card grammar before writing. The `intake` skill slices a person's retelling into that draft, and `attach` now carries it as a tenth carrier.

- [#533](https://github.com/E1i/mikoshi-construct/pull/533) [`6dad0a2`](https://github.com/E1i/mikoshi-construct/commit/6dad0a2b3924e0c7a7a7efefbc3ef7d2f4c7defc) Thanks [@E1i](https://github.com/E1i)! - templates: the `/implement` ladder runs on a red base whose failures are identified and pinned, and passes a rung that adds no failure; a base red in a way that cannot be identified still runs nothing.

### Patch Changes

- [#539](https://github.com/E1i/mikoshi-construct/pull/539) [`740f828`](https://github.com/E1i/mikoshi-construct/commit/740f828d88054148b2ee1126d487fd77d7886a03) Thanks [@E1i](https://github.com/E1i)! - skill: the intake skill writes the taken numbers to a file beside the draft and passes `--taken <file>` instead of piping them, names `pnpm --silent dev intake` for the repository that builds construct, and describes the confirmation gate: exit `2` with a token, `--confirm <token>`, `--auto-confirm` off by default, the `intake` journal line, and a confirmed card keeping the draft's `who`.

- [#538](https://github.com/E1i/mikoshi-construct/pull/538) [`e7d9cb9`](https://github.com/E1i/mikoshi-construct/commit/e7d9cb9784ab2ce76c842bef505e38cf22f02db2) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake --taken -` and `construct board --prs -` wait for a slow producer on stdin instead of refusing with EAGAIN.

## 0.39.0

### Minor Changes

- [#498](https://github.com/E1i/mikoshi-construct/pull/498) [`a459805`](https://github.com/E1i/mikoshi-construct/commit/a459805f6448d1aec3b68527a59fdb2459bf8d88) Thanks [@E1i](https://github.com/E1i)! - cli: `attach` refuses a repository that already holds `.construct/attach.json`, whether or not its carriers are still there, and leaves the record as it was

- [#504](https://github.com/E1i/mikoshi-construct/pull/504) [`c0db020`](https://github.com/E1i/mikoshi-construct/commit/c0db020ac8ad242b411e6b0422d87717036a2548) Thanks [@E1i](https://github.com/E1i)! - templates: `init` and `attach` also write `scripts/construct/check-baseline.mjs`, which runs every harness step even after a red one and prints, for each step, the eslint, Vitest, Jest or tsc failures it recognises (`null` when it recognises none) and the sha256 of the whole set; nothing calls it yet.

- [#495](https://github.com/E1i/mikoshi-construct/pull/495) [`cd991cc`](https://github.com/E1i/mikoshi-construct/commit/cd991ccf05bbde299dd06a1ab67733eacc64d901) Thanks [@E1i](https://github.com/E1i)! - cli: `construct cost` ends with a signal block per class of finished cheap task — the median tokens (input, cache writes and output; cache reads left out) and minutes from five tasks or more, or none with the count below that

- [#511](https://github.com/E1i/mikoshi-construct/pull/511) [`3de32f4`](https://github.com/E1i/mikoshi-construct/commit/3de32f455bdcd876bd5147b0e7ed999f3e092e17) Thanks [@E1i](https://github.com/E1i)! - templates and cli: the `/implement` entry card's `EXPECT` names what it covers — `ladder: <forecast> · brief, review not recorded` — so it no longer reads as the cost of the whole task; `construct cost` prints its run, multi-run and turn-journal totals in tokens without cache reads (input, cache writes and output), the unit of the step split and the forecasts, and names that unit on the total line, so a total from before this release is larger than the same run reads now

- [#494](https://github.com/E1i/mikoshi-construct/pull/494) [`e7609f7`](https://github.com/E1i/mikoshi-construct/commit/e7609f733ba4be64ff7a5dec734fb868c59b4de4) Thanks [@E1i](https://github.com/E1i)! - templates: /implement's report names the rung the run passed on, and says so when no rung passed

- [#508](https://github.com/E1i/mikoshi-construct/pull/508) [`d380646`](https://github.com/E1i/mikoshi-construct/commit/d380646257489cffd222aa14da31d6837a50e28e) Thanks [@E1i](https://github.com/E1i)! - templates: `/implement` prints an entry card before the first token is spent and ends its report with the same card, whose CONTRACT and EXPECT repeat the entry's byte for byte

- [#497](https://github.com/E1i/mikoshi-construct/pull/497) [`5daeac6`](https://github.com/E1i/mikoshi-construct/commit/5daeac67e3572967a772edcb5c855f77d448b816) Thanks [@E1i](https://github.com/E1i)! - cost: the cheap forecast also counts window tasks. `task:close` records when a task ended and each session it used with the project key its session file lies under, and the sample reads those sessions under that key. A session recorded under two tasks counts for neither, and `construct cost` names each task it leaves out, including a close without a verification word.

### Patch Changes

- [#501](https://github.com/E1i/mikoshi-construct/pull/501) [`f564649`](https://github.com/E1i/mikoshi-construct/commit/f5646491757e1030680b069645e5d7c815af4ca3) Thanks [@E1i](https://github.com/E1i)! - ghosts: `pnpm ghosts:hash` runs `check-acceptance build` on the brief's `/implement` text first and prints no hash when the build fails, naming its first error; when the build passes it prints the whole line for the `.approved-sha256` file, `approved /implement text sha256: <hash> (<date>, <approver>; sketch <short sha>|none)`, instead of the bare hash. The approver is `--by <name>`, else `git config user.name`; with neither it refuses and prints no hash

- [#496](https://github.com/E1i/mikoshi-construct/pull/496) [`38a2c3e`](https://github.com/E1i/mikoshi-construct/commit/38a2c3e31999d6a014d27cea0316cffe1c032f75) Thanks [@E1i](https://github.com/E1i)! - cli: the cheap forecast in `construct cost` names its source, Claude Code shift sessions, on its EXPECT line

- [#492](https://github.com/E1i/mikoshi-construct/pull/492) [`a7a8d5a`](https://github.com/E1i/mikoshi-construct/commit/a7a8d5a25fef93ac78a80d814c8631c5427ff26e) Thanks [@E1i](https://github.com/E1i)! - cost: one reader counts a Claude Code session file's tokens for both the step split and the cheap forecast, and the cheap forecast counts them in the ladder's unit — input, cache writes and output, cache reads left out

- [#505](https://github.com/E1i/mikoshi-construct/pull/505) [`f09b1c9`](https://github.com/E1i/mikoshi-construct/commit/f09b1c9b2da8acf1b8de9695724d040e598f5fb6) Thanks [@E1i](https://github.com/E1i)! - ghosts: `pnpm ghosts:expect-sample --effort <e>` prints the brief's `expect:` line from the one sample the brief and the launcher use — the done runs of that effort that `parseLedgerLine` accepts — followed by its sources and every reason a row was left out. The class is optional. A missing ledger or journal, or a class no journal line carries, is named as the reason (`runs not recorded in <ledger>`, `class not recorded on <N> lines in <journal>`) instead of a bare `n=0`. Rows the parser rejects are counted and named (`<N> rows the ledger parser rejects not counted in <ledger>`). Briefs that counted raw rows printed n=64 where this line prints n=58 on the same ledger: the 6-row difference is exactly those rejected old-schema rows. `parseExpect` reads a forecast line that carries this tail.

- [#510](https://github.com/E1i/mikoshi-construct/pull/510) [`29f982c`](https://github.com/E1i/mikoshi-construct/commit/29f982c5a68755b65e5939b42188744d525e34de) Thanks [@E1i](https://github.com/E1i)! - ghosts: `pnpm ghosts:launch` carries a Ghost's ledger lines into the main checkout's `.construct/runs.jsonl` as soon as its session ends, keyed by run, so a later carry adds no duplicate and a Ghost worktree removed by hand no longer takes its run with it. A carry that fails is named on the launcher's line for that task, and the status row is still freed. `architecture/window.md` now says Ghost worktrees are removed only with `pnpm ghosts:cleanup`, never `git worktree remove`.

- [#502](https://github.com/E1i/mikoshi-construct/pull/502) [`4570316`](https://github.com/E1i/mikoshi-construct/commit/45703165cb7dfe8f20fad8e3136d4199dada37f3) Thanks [@E1i](https://github.com/E1i)! - ghosts: the owner-merged kind `ghosts` names the 13 files that change the ladder, approval, merge or security instead of all of `scripts/ghosts/**`, and the other 15 are listed as plain; a file under `scripts/ghosts/` in neither list turns the harness red until it is classified. `architecture/owner-merges.md` is itself owner-merged, under `own-instructions`.

## 0.38.0

### Minor Changes

- [#483](https://github.com/E1i/mikoshi-construct/pull/483) [`235f3bb`](https://github.com/E1i/mikoshi-construct/commit/235f3bbe8f9d26913e4d7dcb2b4d1a745d5c07fc) Thanks [@E1i](https://github.com/E1i)! - templates: `/implement` opens its report with `contract:`, `expect:`, `action:` and `result:`, in that order, each carried from the build's handle, the Workflow run and `.construct/runs.jsonl`; a value no record holds reads `<what> not recorded <where>`, and `expect:` says `expect not recorded in .construct/runs.jsonl` instead of a forecast of the agent's own

## 0.37.0

### Minor Changes

- [#480](https://github.com/E1i/mikoshi-construct/pull/480) [`21f9059`](https://github.com/E1i/mikoshi-construct/commit/21f9059f9f00dd63f4b42a9cb7ef9d8649523004) Thanks [@E1i](https://github.com/E1i)! - cli: `attach` no longer counts a `.construct/` directory as something to attach to: a repository holding nothing but `.construct/`, empty or not, is refused with nothing to attach, as a repository holding only a README already was

- [#482](https://github.com/E1i/mikoshi-construct/pull/482) [`84d86c6`](https://github.com/E1i/mikoshi-construct/commit/84d86c6dc1ea0fc584101afb008ac1341b2c3262) Thanks [@E1i](https://github.com/E1i)! - templates: `attach --entry` has the agent read how the repository names its branches and writes its commits from its history instead of asking: each convention is reported as an observed share with its count and the command that counted it, and a history too small to count, or one where no form holds at least 60%, is said as such, with its search; an absent upstream, `FETCH_HEAD` or interpreter now points to the same rule as every other absence

## 0.36.0

### Minor Changes

- [#475](https://github.com/E1i/mikoshi-construct/pull/475) [`4ebe900`](https://github.com/E1i/mikoshi-construct/commit/4ebe900ddcb7597af19456f31cea3cbd128c9f28) Thanks [@E1i](https://github.com/E1i)! - templates: `attach --entry` has the agent prove every absence it reports — a suite CI does not run, a step left out, no hooks — with the search that reached the CI step or the call where the value decides and what that search returned, and say `not determined` when the search stopped at a config file or a loader

## 0.35.0

### Minor Changes

- [#463](https://github.com/E1i/mikoshi-construct/pull/463) [`86cfe6e`](https://github.com/E1i/mikoshi-construct/commit/86cfe6e9c1b731daf49071a85f327baf6d4a3398) Thanks [@E1i](https://github.com/E1i)! - templates: a browser witness carrier, `scripts/construct/browser-witness.mjs`, starts a dev server on a free port, opens its pages in system Chrome at the widths asked for, and exits 0 when every assertion holds, 1 when one is false and 127 when it could not observe (`could not observe: …`) or was called wrongly (`usage error: …`); `init` and `attach` write it

- [#471](https://github.com/E1i/mikoshi-construct/pull/471) [`2bfdb52`](https://github.com/E1i/mikoshi-construct/commit/2bfdb5295c6bf909891e027fed56c7e546fe1c5b) Thanks [@E1i](https://github.com/E1i)! - templates: the commit guard `attach` installs refuses with exit 2 on everything but an explicit allow, so input that is not a JSON object or an error while checking a call no longer exits 1, on which Claude Code runs the `git commit` anyway

- [#459](https://github.com/E1i/mikoshi-construct/pull/459) [`d6280bf`](https://github.com/E1i/mikoshi-construct/commit/d6280bf0687b93a826f7935d01c2b02ae7df6af0) Thanks [@E1i](https://github.com/E1i)! - templates: `attach --entry` and `/construct-discover` have the agent name, before anything is installed, the Python version a repository needs and the file it came from, the interpreter and the command that selects it, and which locked packages build from source, what that build needs and for which architecture

- [#472](https://github.com/E1i/mikoshi-construct/pull/472) [`a73d5f8`](https://github.com/E1i/mikoshi-construct/commit/a73d5f86c2869e5302d33e1ab11cc11178f333f7) Thanks [@E1i](https://github.com/E1i)! - cli: `construct board` adds the columns `EXPECT` (`expect not recorded in .construct/runs.jsonl` on a ladder row) and `ACTUAL` (the run's tokens and seconds) after `NEXT`; `--json` is unchanged

- [#473](https://github.com/E1i/mikoshi-construct/pull/473) [`90bf98c`](https://github.com/E1i/mikoshi-construct/commit/90bf98cfe0f34face12f2662aed5d58bbda2a5f2) Thanks [@E1i](https://github.com/E1i)! - cli: `construct cost` keeps the steps of each ledger run — role, attempt, effort, tokens, seconds — in `.construct/steps.jsonl`, so a run's split survives after Claude Code clears its session files.

### Patch Changes

- [#460](https://github.com/E1i/mikoshi-construct/pull/460) [`38ac698`](https://github.com/E1i/mikoshi-construct/commit/38ac69839d23367a1e8a10c881f64b018e8abd37) Thanks [@E1i](https://github.com/E1i)! - ghosts: `pnpm ghosts:cleanup` appends a worktree's ladder ledger lines that the main tree's `.construct/runs.jsonl` lacks before it removes the worktree, keeps the worktree when they cannot be written, and `--ledger-only` carries them without removing anything

- [#474](https://github.com/E1i/mikoshi-construct/pull/474) [`30c3a92`](https://github.com/E1i/mikoshi-construct/commit/30c3a9288d973cc8a79623169ca08b8796db31eb) Thanks [@E1i](https://github.com/E1i)! - cli: `construct cost` takes a run's step only from the agent's workflow phase, never from its type; an agent whose phase is not a step is reported unread and its run is not written to the step cache

## 0.34.0

### Minor Changes

- [#456](https://github.com/E1i/mikoshi-construct/pull/456) [`2400dcb`](https://github.com/E1i/mikoshi-construct/commit/2400dcb84e187b8be4a8e59744da0765585e773f) Thanks [@E1i](https://github.com/E1i)! - templates: the `/implement` ladder stops on a witness that fails as on the base only when it does so on two rungs in a row; on one rung the ladder goes on to the next, and a witness the shell cannot run still stops the run at once

## 0.33.1

### Patch Changes

- [#446](https://github.com/E1i/mikoshi-construct/pull/446) [`8fda43b`](https://github.com/E1i/mikoshi-construct/commit/8fda43b14a55a1fad83f50f1509209008e8a76a4) Thanks [@E1i](https://github.com/E1i)! - cli: `construct board` reads a `--prs` list with a null check as unreadable and still prints the board (exit 0), keeps pull request titles whole, and sorts a time ahead of now as the newest in its group

## 0.33.0

### Minor Changes

- [#430](https://github.com/E1i/mikoshi-construct/pull/430) [`dcf29e3`](https://github.com/E1i/mikoshi-construct/commit/dcf29e3c4ba611c9aaf80c941a7bf70e11e52e40) Thanks [@E1i](https://github.com/E1i)! - attach: the commit guard also refuses a commit, push, merge, rebase or tag behind `env -S`, `nice` and `xargs`, or spelled with `$'…'` or `$"…"`

- [#424](https://github.com/E1i/mikoshi-construct/pull/424) [`44b8ae5`](https://github.com/E1i/mikoshi-construct/commit/44b8ae5d8431e44253bc8f9328d71ee33e95ec77) Thanks [@E1i](https://github.com/E1i)! - templates: open questions move out of `AGENTS.md` into `architecture/open-questions.md`, so they stop loading into every session — `AGENTS.md` keeps one line pointing there, `sync` leaves an already-filled block where it was, and the next `/construct-discover` moves it

- [#428](https://github.com/E1i/mikoshi-construct/pull/428) [`4b09370`](https://github.com/E1i/mikoshi-construct/commit/4b093704e9c6d29fac1a04372a37feb42c4dc8fd) Thanks [@E1i](https://github.com/E1i)! - templates: /plan reads each task's risk from what the change does before choosing its contour, and a critical sign asks for the ladder path and a human who approves the brief

- [#443](https://github.com/E1i/mikoshi-construct/pull/443) [`9401d7c`](https://github.com/E1i/mikoshi-construct/commit/9401d7c1d33d6d6408a6a23b221eac5f0b4c2824) Thanks [@E1i](https://github.com/E1i)! - cli: `construct board` shows where each task stands in a repository from the ladder runs in `.construct/runs.jsonl` and a pull request list handed over with `--prs`, and writes no file

- [#441](https://github.com/E1i/mikoshi-construct/pull/441) [`f99a1d2`](https://github.com/E1i/mikoshi-construct/commit/f99a1d29cb046aab8c33f9d9f8c6b133b6c747d0) Thanks [@E1i](https://github.com/E1i)! - cli: the review-verdict contour moves to `review-verdict/2` — a verdict now carries `tree`, the tree it reviewed, and this repository's `ghosts:verdict` refuses it unless that is the tree of the pull request commit; journal lines written under `/1` still read

## 0.32.0

### Minor Changes

- [#421](https://github.com/E1i/mikoshi-construct/pull/421) [`09e3180`](https://github.com/E1i/mikoshi-construct/commit/09e31805b8cf7ba7c5fb79e3d4509c053c2f71e0) Thanks [@E1i](https://github.com/E1i)! - templates: `/implement` starts from the sketch a brief names — the args carry the sketch's tree, a staged sketch is the expected base diff, anything beyond it is a red base, and a staged tree that is not the sketch's stops the run as unverified with both trees named

- [#419](https://github.com/E1i/mikoshi-construct/pull/419) [`a54a139`](https://github.com/E1i/mikoshi-construct/commit/a54a139a498134cbcbd5da397283b658014f153d) Thanks [@E1i](https://github.com/E1i)! - cost: the ledger-row contour is 1.1 — a row may carry `agreedSha256` and `argsSha256`, each 64 lowercase hex, and `construct cost` refuses a row whose hash has another form, naming the field; rows without them read as before; step 4 of the /implement skill copies both from the build handle into the row

## 0.31.0

### Minor Changes

- [#404](https://github.com/E1i/mikoshi-construct/pull/404) [`1f3681b`](https://github.com/E1i/mikoshi-construct/commit/1f3681b2cc164ddcb1909f7a53e46139f81ab739) Thanks [@E1i](https://github.com/E1i)! - templates: the /implement ladder reads its args by path and sha256 — check-acceptance build --out writes .construct/implement-args.json and prints a handle, the Workflow receives the handle and never the file, the harness reports the file's sha256 on every call and extracts each witness through a witness mode that refuses another hash, and a mismatch ends the run as args unverified

- [#409](https://github.com/E1i/mikoshi-construct/pull/409) [`82fb68f`](https://github.com/E1i/mikoshi-construct/commit/82fb68fe899aa481d10e665081373ff5245baf71) Thanks [@E1i](https://github.com/E1i)! - cli: contract/contours/ledger-row.schema.json records the run ledger row and construct cost refuses a row whose run is present but not a non-empty string; the launcher, the watch and the board read the same shape through parseLedgerLine

- [#398](https://github.com/E1i/mikoshi-construct/pull/398) [`b40da12`](https://github.com/E1i/mikoshi-construct/commit/b40da127c8ee385bcbf020b5b58cd87146c96afd) Thanks [@E1i](https://github.com/E1i)! - cli: the commit guard attach installs finishes its stdin read without a top-level await, and every hook script this repository ships is linted for a synchronous stdin read

- [#396](https://github.com/E1i/mikoshi-construct/pull/396) [`dd4c32c`](https://github.com/E1i/mikoshi-construct/commit/dd4c32c4cbd6cadd183a51ac2392162a4706e2e3) Thanks [@E1i](https://github.com/E1i)! - cli: cost reports the turn journal that this repository's Claude Code hooks write to .construct/turns.jsonl, as turns, sessions, main-thread and subagent usage, unmeasured turns and gaps, and reads an absent journal as not recorded

### Patch Changes

- [#408](https://github.com/E1i/mikoshi-construct/pull/408) [`9f9973a`](https://github.com/E1i/mikoshi-construct/commit/9f9973aa2fcb0f6d78cdd3fc7a5515571685ec90) Thanks [@E1i](https://github.com/E1i)! - templates: the /implement ladder extracts each witness by its sha256 instead of its position, so a handle that drops or reorders a criterion no longer runs another criterion's command; check-acceptance witness takes --witness-sha256 in place of --n

## 0.30.0

### Minor Changes

- [#392](https://github.com/E1i/mikoshi-construct/pull/392) [`16d379e`](https://github.com/E1i/mikoshi-construct/commit/16d379e630122d04f5d14cd04be0ec821a9d6e4a) Thanks [@E1i](https://github.com/E1i)! - cli: upgrade the CLI before running detach on a repository this release attached, because attach now writes a PreToolUse guard into the untracked `.claude/settings.local.json` that refuses the agent a `git commit`, push, merge, `rebase` or tag, recordVersion becomes 2, and an older detach refuses that record and removes nothing while `detach` here takes exactly that entry out

- [#389](https://github.com/E1i/mikoshi-construct/pull/389) [`a4f3a92`](https://github.com/E1i/mikoshi-construct/commit/a4f3a9237969202633b35608baf25ccdf5ee1560) Thanks [@E1i](https://github.com/E1i)! - cli: attach --entry prints the protocol by which the agent reads a repository and proposes one harness the owner answers yes or no; the no-harness refusal names it, and a collision labels each existing path construct's own or not recognised against the known set of earlier files and prints the one command that deletes only the recognised ones and runs attach again

## 0.29.0

### Minor Changes

- [#381](https://github.com/E1i/mikoshi-construct/pull/381) [`e6b86a3`](https://github.com/E1i/mikoshi-construct/commit/e6b86a3eebd349ca0e5b6f7f6258f679f696f722) Thanks [@E1i](https://github.com/E1i)! - cli: attach refuses a harness whose first word is not a command on PATH (a script name such as `quality`, or `vitest` from `node_modules/.bin`) and prints the command to use instead, and warns when the harness edits files (`:fix`, `--fix`, `--write`)

## 0.28.0

### Minor Changes

- [#363](https://github.com/E1i/mikoshi-construct/pull/363) [`7522771`](https://github.com/E1i/mikoshi-construct/commit/75227713f7a4e84a2b65ab16d28c3a33be9d00b2) Thanks [@E1i](https://github.com/E1i)! - The ladder counts a declared contract check as run only when the harness reports it under the exact command declared in AGENTS.md; a check reported under any other command is `contract check failed`, with both commands named.

- [#374](https://github.com/E1i/mikoshi-construct/pull/374) [`89b3a6b`](https://github.com/E1i/mikoshi-construct/commit/89b3a6b4059d9d040c8ee71bf12301b620db2599) Thanks [@E1i](https://github.com/E1i)! - cli: `construct detach` removes `.construct/` only when `attach` created it. `attach` records this as `ledgerCreated` in `.construct/attach.json`. Before, detach removed an empty `.construct/` that already existed before attach, a directory it had no record of creating. A record written before this field existed does not say, so detach leaves `.construct/` in place.

- [#372](https://github.com/E1i/mikoshi-construct/pull/372) [`183e731`](https://github.com/E1i/mikoshi-construct/commit/183e731be2beed6660d350c146b79bb59f8cc365) Thanks [@E1i](https://github.com/E1i)! - templates: the discovery protocol's inventory step reads every README, at the root and in each app, from start to end before it writes down how to install, run or test anything. Before, it named the configs and entry points but not the README, and a partial read left out the environment and the dev server commands that the README stated.

- [#362](https://github.com/E1i/mikoshi-construct/pull/362) [`eb735e7`](https://github.com/E1i/mikoshi-construct/commit/eb735e7a5d3abdb42c349651b48c2cb04979619c) Thanks [@E1i](https://github.com/E1i)! - The harness agent reads a pytest skip or expected failure added to a test as a weakened test: `@pytest.mark.skip`, `@pytest.mark.skipif` and `@pytest.mark.xfail`, with or without parentheses, and `pytest.skip(` / `pytest.xfail(` calls. Before, only `.skip(` and `.only(` were named, which a bare `@pytest.mark.skip` does not match.

- [#361](https://github.com/E1i/mikoshi-construct/pull/361) [`2cb8c27`](https://github.com/E1i/mikoshi-construct/commit/2cb8c27bb08991dc187de01e865984729f55b12f) Thanks [@E1i](https://github.com/E1i)! - The `/implement` skill uses `.construct/implement-agreed.txt` as it is when the file already exists, instead of rewriting it from `$ARGUMENTS`. The Ghost launcher now writes that file from the approved brief before the session starts, so the agent no longer retypes the text the witnesses are parsed from.

- [#375](https://github.com/E1i/mikoshi-construct/pull/375) [`43e1a9d`](https://github.com/E1i/mikoshi-construct/commit/43e1a9d9c40d31676092f0d1e249665b04c49a65) Thanks [@E1i](https://github.com/E1i)! - templates: the ladder script is now `scripts/construct/implement.workflow`, with no `.mjs`. What to do: in a repository made by `init`, run `construct sync --apply`. It removes `scripts/construct/implement.workflow.mjs` when its bytes are still what was recorded and writes the new path; sync reports this as the new class `moved`, and `--json` lists it under `retired`. If you edited the old file, sync writes neither path and reports both as `conflict`; move your edits across by hand. In an attached repository, run `construct detach`, then `construct attach`. Why: the script ends with a top-level `return`, the format the Workflow runtime runs, and a repository whose harness is `eslint .` parsed the `.mjs` and went red on its first check after attach. ESLint does not lint a file without a JavaScript extension, so the generated `eslint.config.mjs` no longer needs, and no longer carries, the `scripts/construct/*.workflow.mjs` ignore.

## 0.27.0

### Minor Changes

- [#332](https://github.com/E1i/mikoshi-construct/pull/332) [`6c7c143`](https://github.com/E1i/mikoshi-construct/commit/6c7c143caf3992af7e62fdcd29b952a816652e25) Thanks [@E1i](https://github.com/E1i)! - templates: the `/implement` ladder now reads the `Contract paths:` and `Contract check:` lines from the repository's AGENTS.md, never from CLAUDE.md — a line found only in CLAUDE.md makes the build refuse, naming it and saying it moved to AGENTS.md. When a repository declares a `Contract check:` line, the ladder runs it after the harness command passes and a red or unreported check ends the rung `contract check failed`, never `done`.

- [#282](https://github.com/E1i/mikoshi-construct/pull/282) [`32977e5`](https://github.com/E1i/mikoshi-construct/commit/32977e58ac0825f002c2c6a38cbfa8e8b20ec9c3) Thanks [@E1i](https://github.com/E1i)! - templates: the `/implement` skill no longer has the agent copy the brief's acceptance, witnesses, invariants and immutable paths into the ladder's args. `node scripts/construct/check-acceptance.mjs build --brief <file>` parses the brief and prints the whole args object, `harness` included, and the skill passes it to the Workflow unchanged; a brief with no acceptance, an item with no witness or a witness holding a backtick is refused with the item and the reason, and nothing is printed on stdout. A label counts only at the start of a line or after the end of a sentence, and the witness is read after the last `— witness:` outside backticks; the check mode (`--agreed` / `--args`) reads briefs through the same parser.

- [#348](https://github.com/E1i/mikoshi-construct/pull/348) [`01717ed`](https://github.com/E1i/mikoshi-construct/commit/01717edea964bc36f17a383b06212b0c4b0e8562) Thanks [@E1i](https://github.com/E1i)! - templates: the `/implement` ladder no longer asks the harness agent to report a witness's `command`. Since a reported witness is matched to the brief's by its criterion and `ranSha256`, the field decided nothing; the verify prompt, `.claude/agents/harness.md` and the verdict schema drop it. A contract check is declared only when `harness.contractCheck` is a non-empty string, so an `undefined`, `null` or numeric value leaves every harness prompt unchanged instead of asking for a check named `undefined`. A red contract check's reason now names the command and its exit code (`pnpm contract:bump exited 1`), followed by its last lines when it reported any, so a check with an empty excerpt no longer hands the next implementer an empty reason.

- [#286](https://github.com/E1i/mikoshi-construct/pull/286) [`52b2aa1`](https://github.com/E1i/mikoshi-construct/commit/52b2aa15eb562018ee50a9b1e3badc7e45200c95) Thanks [@E1i](https://github.com/E1i)! - templates: the `/implement` ladder's outcome is now `untested change` — never `done` — for a rung that changed a source file (a path with a `src/` segment ending in `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` or `.cjs`, not `.d.ts`) and no test file (a path with a `tests/` segment named `*.test.` with one of those extensions); the attempt's reason names the source files, and the run goes on to the next rung. A red harness, an unchanged tree, an immutable path and an unwitnessed acceptance keep their own outcomes.

- [#318](https://github.com/E1i/mikoshi-construct/pull/318) [`d75d52c`](https://github.com/E1i/mikoshi-construct/commit/d75d52ca5fe4a6ea7783af75b06e9b40d71591cd) Thanks [@E1i](https://github.com/E1i)! - templates: `/plan` gains the brief and witness rules: the Design and the Invariants must not contradict each other; a Design names every file its own decisions force; each witness is run as the ladder runs it (`bash -n`, red on the base for a behavioural reason, green on a known solution where one exists) before approval, and a changed brief goes back for a new approval; the fixtures its witnesses run against are merged before the ladder starts; a block of witness-writing rules; producer and consumer order by what passes between them (a data format: the reader first; a behaviour: the consumer last); deferrals, import rules for a new module, half-done migrations and verifications each get a task of their own; and a `high` task is planned as its design step followed by `medium` implementation tasks carrying the settled design. The implement skill states where a ladder may start (the task's own worktree, never after `EnterWorktree`), links `high` to the design it requires, and keeps the tree read-only after `done`. The security invariants header and discovery step 10 require `Enforced by` to name the mechanism and what it matches, never a bare tool name.

- [#296](https://github.com/E1i/mikoshi-construct/pull/296) [`163ab4c`](https://github.com/E1i/mikoshi-construct/commit/163ab4cbfab9956093bfa8ebba8d81d8587b6cdd) Thanks [@E1i](https://github.com/E1i)! - templates: `/plan` gains two rules. Every line of a task brief's Design, and every case a line lists, is held by a should / should-not witness pair or fixture pair; the brief's author checks Design line → witness line by line before approval and gives an unheld line a witness or removes it. Independent tasks — write contours that do not intersect, no dependency on each other's results — are planned and run in parallel by default (subagents for reviews, checks and brief preparation; separate sessions or worktrees for implementation), and a task is sequential only when it shares a write resource or needs another's result, which the plan states in one line.

- [#346](https://github.com/E1i/mikoshi-construct/pull/346) [`78d8889`](https://github.com/E1i/mikoshi-construct/commit/78d8889beffcd9cbae55697fdac9ceba787df158) Thanks [@E1i](https://github.com/E1i)! - templates: `/plan` outputs each ladder-path task as the full skeleton of its brief — the `/implement` line, `Effort:`, `Design:`, `Acceptance:` with a `— witness:` per item, `Invariants:` and `Immutable:` — in the shape the implement build parses, instead of a one-line task the build refused for having no `Acceptance:` section. `/plan` also states that a task is never done twice: the brief proves its witnesses executable and does not implement the task, and an implementation its author wrote anyway becomes the pull request with no Ghost launched.

- [#341](https://github.com/E1i/mikoshi-construct/pull/341) [`dee1ff3`](https://github.com/E1i/mikoshi-construct/commit/dee1ff3363097bd82fb94a3188ec15d2f4b08736) Thanks [@E1i](https://github.com/E1i)! - templates: a `/implement` witness that cannot be witnessed is no longer read as a red one. When, after the change, a witness exits 126 or 127, exits 2 with a shell syntax error, or fails with the same exit code and the same last lines as on the base (temporary paths replaced by `<tmp>`), the rung's outcome is `witness invalid`, its reason names the witness, and the ladder stops at once with `base unverified`: no higher rung and no design step, since no implementation could turn that witness green. The harness agent now reports each witness's last lines on the working tree as `afterExcerpt`. A witness red on the base and green after, or red after with a different failure, is decided as before. A reported witness is now matched to the brief's by its criterion and its `ranSha256`: the `command` the harness copies back is informational, so a paraphrased command no longer turns a witnessed criterion into `acceptance not witnessed`, and a sha that differs is `witness not run verbatim` whatever command is reported.

- [#301](https://github.com/E1i/mikoshi-construct/pull/301) [`505ebff`](https://github.com/E1i/mikoshi-construct/commit/505ebff8b20b2d456f46c0e9a3cddf6b715999e7) Thanks [@E1i](https://github.com/E1i)! - templates: the `/implement` ladder now runs every witness verbatim. The build keeps a witness command byte for byte (double spaces, tabs and newlines inside the backticks survive), refuses one `bash -n` rejects before calling any agent with the item, `bash -n` and bash's own message, and prints `witnessDigests` — each witness's criterion, base64 and sha256 of the raw command — alongside `witnesses`. The verify prompt gives the harness agent each witness only as base64, in three fixed lines (decode, `shasum -a 256`, run), never the raw command; the verdict schema now requires `ranSha256`, and a rung whose reported sha256 does not match the digest is `witness not run verbatim`, checked after an immutable path and before an unwitnessed acceptance, never `done`. A brief's `Design:` section, when present, is carried verbatim into `args.design` and into the architect's and implementer's prompts; a run whose witness has no digest in `args.witnessDigests` is blocked before any agent.

### Patch Changes

- [#327](https://github.com/E1i/mikoshi-construct/pull/327) [`0811e65`](https://github.com/E1i/mikoshi-construct/commit/0811e6506deb9872d6df57f380af21ac3cf7ef79) Thanks [@E1i](https://github.com/E1i)! - templates: `architecture/principles.md` names the principle behind the reasoning budget — every change goes through the cheapest contour that yields the proof it needs, and not every change goes through the ladder — and `/plan` chooses each task's contour first: a cheap path (an ordinary session, the harness and CI) or a ladder path (a brief with witnesses, run by `/implement`), with the criteria for each.

- [#307](https://github.com/E1i/mikoshi-construct/pull/307) [`d9eddf1`](https://github.com/E1i/mikoshi-construct/commit/d9eddf134cc1d87184f983eb8b1659c28c168d76) Thanks [@E1i](https://github.com/E1i)! - templates: the `/implement` ladder's verify prompt now names the witness scratch directory once, up front — "Make `<dir>` once, before the first witness, with `mktemp -d`, and write the absolute path it printed wherever `<dir>` stands: it lies outside the repository, so it still resolves after the `cd` into the base worktree and adds no file to the working tree" — instead of the single "in a scratch directory of your own, `<dir>`", which said where the scripts go but not how or when to make that directory; `.claude/agents/harness.md` says the same. A brief's empty `Design:` section (`design: ""`) no longer puts a `Design from the brief:` block into the architect's or the implementer's prompt, and the build's `Design:` label counts only at the start of a line, so one written mid-sentence stays plain text.

## 0.26.0

### Minor Changes

- [#276](https://github.com/E1i/mikoshi-construct/pull/276) [`7614b0a`](https://github.com/E1i/mikoshi-construct/commit/7614b0abdef3b7b04abc7357d637e321f8839926) Thanks [@E1i](https://github.com/E1i)! - cli: every command refuses a flag it does not declare, and `init --preset`, `init --ai`, `init --review`, `attach --ai` and `mutate judge --format` refuse a value outside their options, before anything is read or written: the usage is printed, stderr names every unknown flag as it was typed (or the flag, the value and every allowed one), and the exit code is 1. A script that passed a misspelt or unsupported flag and had it silently ignored now fails; drop or correct the flag. `contract/surface.json` records the options of each enumerable flag, as an optional field (`surfaceVersion` stays 2: a file without it records flags that had no options), and `contract:bump` reads an option removed as breaking and an option added as additive. Previously `mutate judge --format junit` was read as the default Vitest JSON and reported the report as not JSON; it is now refused naming `vitest-json` and `junit-xml`.

## 0.25.1

### Patch Changes

- [#264](https://github.com/E1i/mikoshi-construct/pull/264) [`8e737a8`](https://github.com/E1i/mikoshi-construct/commit/8e737a84655644b75ff64f9b503e3bc438bc8cc7) Thanks [@E1i](https://github.com/E1i)! - cli: `construct cost` joins a ledger entry to its run when the run's session was started in a git worktree. Claude Code files a session under the directory it started in, so a ladder run from a worktree session read as `entriesWithoutSession` from the main checkout, and stayed that way after the worktree was removed. A run the ledger names and this directory's sessions do not hold is now looked up by its `run` identifier under every other project key; only runs the ledger names are taken from there.

- [#272](https://github.com/E1i/mikoshi-construct/pull/272) [`7b9dfcb`](https://github.com/E1i/mikoshi-construct/commit/7b9dfcbeeb166f088dbc29e05aba7eba057e99d4) Thanks [@E1i](https://github.com/E1i)! - cli: with a harness command the user named, `construct.model.json` no longer claims what that command runs. `every-change-passes-the-harness` states `<command> passes on every change` with no verification when the harness is not `pnpm run quality`, instead of always claiming lint, typecheck and tests pass with an ESLint verification it cannot know holds; `lint-policy` is not born at all, since it names a pnpm script and a test file the harness command may not run.

- [#270](https://github.com/E1i/mikoshi-construct/pull/270) [`95b53d9`](https://github.com/E1i/mikoshi-construct/commit/95b53d9b958877407ffd25a95c29506684bd29e3) Thanks [@E1i](https://github.com/E1i)! - cli: `init` takes `--harness <command>`, as `attach` does. Without it, a repeated `init` keeps the command recorded in `construct.json` by the previous run, and a first `init` still defaults to `pnpm run quality`. The `harness-steps` claim — which spells out the pnpm scripts the harness command runs — is only born when the harness command is `pnpm run quality`; any other command leaves that claim unwritten, since the construct cannot know what it runs.

- [#273](https://github.com/E1i/mikoshi-construct/pull/273) [`8c67db5`](https://github.com/E1i/mikoshi-construct/commit/8c67db50709febf69a4a17b1850546e7f94ea4df) Thanks [@E1i](https://github.com/E1i)! - cli: `mutate judge` takes `--format vitest-json` (the default) or `--format junit-xml`, so a JUnit
  XML report from any runner can stand in for Vitest's json reporter. A JUnit report is refused,
  naming the missing run start time, when none of its `<testsuite>` elements carries a `timestamp`
  attribute — the file's own modification time is never used as a stand-in.

- [#274](https://github.com/E1i/mikoshi-construct/pull/274) [`86c9fdb`](https://github.com/E1i/mikoshi-construct/commit/86c9fdb711e16c5429790a7eb1f4869deb46aebf) Thanks [@E1i](https://github.com/E1i)! - cli: with a harness command other than `pnpm run quality`, `construct.model.json` no longer carries the facts `lint-policy-test` and `lint-policy-test-loads-eslint`, which only the `lint-policy` claim stood on and which that harness leaves unwritten.

## 0.25.0

### Minor Changes

- [#256](https://github.com/E1i/mikoshi-construct/pull/256) [`b73b16e`](https://github.com/E1i/mikoshi-construct/commit/b73b16ed91a8aaa3805853ba64b22a4bcc22869e) Thanks [@E1i](https://github.com/E1i)! - templates: a brief can name `Immutable:` paths — files, or directories ending in `/` — that the change may not touch. `check-acceptance` stops when one is missing from the args, and the ladder fails a rung whose changed files include one as `immutable changed`, even with the harness green and every acceptance item witnessed.

### Patch Changes

- [#260](https://github.com/E1i/mikoshi-construct/pull/260) [`472adba`](https://github.com/E1i/mikoshi-construct/commit/472adba12013165398dea9b67c61943483ebb064) Thanks [@E1i](https://github.com/E1i)! - cli: doctor reads an attached repository (no construct.json, `.construct/attach.json` present) as `state: "attached"` with the harness command and its coverage state, instead of reporting no-manifest.

## 0.24.0

### Minor Changes

- [#243](https://github.com/E1i/mikoshi-construct/pull/243) [`6aa1cc8`](https://github.com/E1i/mikoshi-construct/commit/6aa1cc8d5d7f20f3cf7a2224815dbc75f80381b5) Thanks [@E1i](https://github.com/E1i)! - A `report-covers` or `report-misses` fact carries a `format`: `vitest-json` (the default, read when
  `format` is absent) or `junit-xml`. Point a `junit-xml` fact's `path` at a report produced by
  `pytest -o junit_family=xunit1 --junitxml=<path>`; the reader takes a testcase's repository path only
  from its `file` attribute, reads a `<skipped>` testcase as not run and `<failure>`/`<error>` as run,
  and yields `unknown` coverage rather than throwing on a file it cannot parse. The model format goes to
  `modelVersion` 3.

### Patch Changes

- [#245](https://github.com/E1i/mikoshi-construct/pull/245) [`67d7268`](https://github.com/E1i/mikoshi-construct/commit/67d7268b7b0fe1d64f18f44d75dccf0b837cdcec) Thanks [@E1i](https://github.com/E1i)! - `attach` no longer reads the stack. It refused a repository whose detected layout was `empty` or `unknown`, and that detector reads directory names: a Go repository with a `services/` directory attached, while the same repository without it was refused ([#232](https://github.com/E1i/mikoshi-construct/issues/232)). Now a repository with anything in it attaches whatever it is written in. Only a tree holding nothing but `.git` and the files an empty directory may hold is refused, as `Refused: this repository holds nothing to attach to.` `doctor` does not read an attached repository yet: it answers `No construct.json here`, so nothing reports whether the harness you name covers the code ([#247](https://github.com/E1i/mikoshi-construct/issues/247)).

- [#244](https://github.com/E1i/mikoshi-construct/pull/244) [`5558437`](https://github.com/E1i/mikoshi-construct/commit/55584378c440699e841c44ba63f029335026663a) Thanks [@E1i](https://github.com/E1i)! - The implement skill says to start the ladder only from a turn whose only user message is the `/implement` itself. The Workflow runtime relays the message that triggered the run to the ladder's agents as a request that outranks the computed brief, so a message sent in the same turn becomes the implementer's task. The ladder cannot check this, and the skill says that the rule holds by discipline alone.

## 0.23.0

### Minor Changes

- [#234](https://github.com/E1i/mikoshi-construct/pull/234) [`ef66481`](https://github.com/E1i/mikoshi-construct/commit/ef66481c4bb7e4452177a7c080cef609d1a86d58) Thanks [@E1i](https://github.com/E1i)! - Breaking: `doctor --json` `harness.state` gains `does-not-cover`, and `checked` changes meaning (decision 0033). It is now the projection of the verification stage of the discovery-written claim `harness-covers-target`: `checked` only when a Vitest JSON report lists a file of the repository's own verification surface as executed, `does-not-cover` when a complete, fresh report shows none of it ran, `unknown` otherwise. A consumer that read `checked` as "the command is a package script" now gets `unknown` on the same repository; `harnessProblems` and `ok` are unchanged. The model format goes to `modelVersion` 2 with the fact kinds `file-lacks`, `report-covers` and `report-misses`. `construct graph` draws report-backed entries in a fixed `runtime-report` class and never reads a report.

### Patch Changes

- [#239](https://github.com/E1i/mikoshi-construct/pull/239) [`36f7abc`](https://github.com/E1i/mikoshi-construct/commit/36f7abc9815cea1962b05bcf98bdcec193ba9fc5) Thanks [@E1i](https://github.com/E1i)! - The generated `.claude/agents/implementer.md` runs the implementer with `model: sonnet` instead of `inherit`, so the low-effort rung no longer runs on whatever model the session uses. The architect and harness agents still inherit. The Cursor channel is not affected. The Sonnet default is under observation; set `model: inherit` to go back.

- [#241](https://github.com/E1i/mikoshi-construct/pull/241) [`dfd14aa`](https://github.com/E1i/mikoshi-construct/commit/dfd14aa5242c88c65173b1de9413643f007f51b8) Thanks [@E1i](https://github.com/E1i)! - The implement ladder reports `done` only when every acceptance item from the brief was witnessed failing on the base and passing after the change. Before, a green harness was enough, and a rung that changed nothing passed on a tree that was green by construction.
  
  - Each acceptance item ends with its witness, `` — witness: `<command>` ``. The witness is fixed in the brief before the run. The implementer only sees it and cannot substitute one, and `check-acceptance` stops a run whose args carry a different witness.
  - The harness runs each witness twice: on the working tree, and against the base sha in a worktree of its own, never by stashing or rewriting files in the working tree.
  - A brief now splits into acceptance, which must go from red to green and is the gate, and an `Invariants:` section, which stays green throughout and is held by the harness. An item such as "the harness is green" belongs in invariants.
  - A base that cannot witness reads `base unverified` and ends the run, never red: no install ran or the install failed, or a witness could not run on the base because a command or a package is missing.
  - A rung that changes no file is a `no change` attempt. A brief with no acceptance, or an acceptance item with no witness, returns `blocked` before any agent runs.

- [#237](https://github.com/E1i/mikoshi-construct/pull/237) [`9f2e45a`](https://github.com/E1i/mikoshi-construct/commit/9f2e45a8b34ee27c535e4da18959fce0fb0109b1) Thanks [@E1i](https://github.com/E1i)! - A freshly initialised project installs again. Vitest 5.0.2 depends on `why-is-node-running ^3.2.1`, which resolved to 3.2.2 — a release published without the provenance 3.2.1 carries — and the generated `trustPolicy: no-downgrade` refused it, so `pnpm install` failed on every preset. The generated `pnpm-workspace.yaml` now overrides `why-is-node-running` to 3.2.1 rather than exempting 3.2.2 from the trust check. A project already initialised can add the same `overrides` entry to its `pnpm-workspace.yaml`.

## 0.22.0

### Minor Changes

- [#231](https://github.com/E1i/mikoshi-construct/pull/231) [`8756aea`](https://github.com/E1i/mikoshi-construct/commit/8756aeaf1b0fdca1d856561112d619830ddec7e2) Thanks [@E1i](https://github.com/E1i)! - sync: `construct.json` moves to manifest version 6 (decision 0032). Every write of a block target (`AGENTS.md`, `CLAUDE.md`, `.gitignore`) by `init` or `sync --apply` now records the sha of the construct block's owned view and a snapshot of the vars it was written with. With these, `sync` reads such a target as `block-edited` (the block differs from what was written), `record-vars-edited` (the block is what was written but `vars` in `construct.json` changed since), `template-moved-on` (both as written, today's template renders differently; `--apply` writes it) or `keep`. A record cut before version 6 is never back-filled: where it reads `unknown`, sync says the record predates the fields that would answer, and running the construct again records them. `sync --json` gains the count keys `block-edited`, `record-vars-edited` and `template-moved-on`.

### Patch Changes

- [#229](https://github.com/E1i/mikoshi-construct/pull/229) [`807d1ef`](https://github.com/E1i/mikoshi-construct/commit/807d1ef07a6a749d3935f9c9dab1bbd91cb19500) Thanks [@E1i](https://github.com/E1i)! - release: a publish that awaits approval reads as pending, not as absent. The Release run publishes with `npm stage publish` (npm 11.15.0 or newer, which the job now installs) instead of `changeset publish`. It uploads `{version, stageId}` as the `release-stage` artifact, and `changeset tag` still writes the git tags and GitHub releases. Release verification downloads that record. If the version is absent from the registry and a stage record exists for it, the run prints the stage id with a notice to re-run this run after approval, then cancels itself: it ends grey, and Published smoke stays skipped. If the cancellation does not take effect, the run ends red, never green. If the version is absent with no stage record, it still fails with the same message as before.

## 0.21.0

### Minor Changes

- [#225](https://github.com/E1i/mikoshi-construct/pull/225) [`d05d282`](https://github.com/E1i/mikoshi-construct/commit/d05d282239dbd74a8a5ba73316f9faf0ab1220a3) Thanks [@E1i](https://github.com/E1i)! - templates: the ladder derives `contractChanged` instead of asking the harness agent to judge it. The harness agent reports `changedFiles` — `git diff --name-only HEAD` plus untracked files, verbatim — and the VERDICT schema no longer has a `contractChanged` field. `implement.workflow.mjs` sets the result's `contractChanged` when a changed file equals, exactly, one of `args.harness.contractPaths`, and returns `changedFiles` beside it. The `/implement` skill fills `contractPaths` by reading `contracts.path` and `contracts.types` from `construct.json` and a `Contract paths:` line from `CLAUDE.md`; `.construct/attach.json` records no contract paths, so an attached repository names them in that line.

- [#222](https://github.com/E1i/mikoshi-construct/pull/222) [`c5a8882`](https://github.com/E1i/mikoshi-construct/commit/c5a8882cd70073b73a124e2de62d611487b4416f) Thanks [@E1i](https://github.com/E1i)! - templates: `AGENTS.md` and `.github/workflows/ci.yml` name the recorded harness command instead of a literal `pnpm run quality`, and the workflow's quality step quotes a command that would not parse as a bare YAML scalar (one carrying `: ` or ` #`), so its `run` is the command verbatim; with `pnpm run quality` the output is unchanged byte for byte. `construct doctor` checks a `pnpm`/`npm`/`yarn`/`bun` script command against `package.json` as before, and reports any other command — `make check`, say — as `harness.state: "unknown"`, named in the output as not statically checkable, rather than as a missing `package.json`; `doctor --json` gains the `harness` field, and `unknown` never makes `ok` false.

## 0.20.0

### Minor Changes

- [#211](https://github.com/E1i/mikoshi-construct/pull/211) [`6a95be8`](https://github.com/E1i/mikoshi-construct/commit/6a95be827378b2b6a2d3df3b626a0171574b85e0) Thanks [@E1i](https://github.com/E1i)! - templates: `/implement` copies an agreed `Acceptance:` section into the ladder's arguments verbatim and checks it with `scripts/construct/check-acceptance.mjs` before calling the ladder, stopping when an agreed item dropped out; the ladder logs the acceptance it received and echoes it as `acceptance` on every result, and `construct attach` now writes the check as a seventh file.

## 0.19.1

### Patch Changes

- [#205](https://github.com/E1i/mikoshi-construct/pull/205) [`e0e2b28`](https://github.com/E1i/mikoshi-construct/commit/e0e2b2856bdf385a69f9bc13a86b80d5cb187f9b) Thanks [@E1i](https://github.com/E1i)! - cli: `construct mutate apply --from <file> --id <id>` applies a brief's named wrong implementation with a copy and a record in `.construct/mutations/`, and `construct mutate judge --id <id> --report <file>` restores it byte for byte from the copy and judges the outcome from the Vitest JSON report the runner hands over (`--baseline` records the green run apply requires); the CLI runs no test itself.

## 0.19.0

### Minor Changes

- [#196](https://github.com/E1i/mikoshi-construct/pull/196) [`0f905ea`](https://github.com/E1i/mikoshi-construct/commit/0f905ead82fce992234c15b8222726d1ee19a2a5) Thanks [@E1i](https://github.com/E1i)! - contract: CI computes the bump a pull request's change to the public surface requires and fails when the declared bump is weaker. `contract/surface.json` gains `surfaceVersion` 2 and records the JSON type of each `--json` sample's root beside its key paths. `pnpm contract:bump` compares the surface at the latest release tag reachable from `HEAD` with the surface at `HEAD`: before 1.0, additions require at least a patch changeset and a breaking change at least a minor one. No command-line behaviour changes.

- [#198](https://github.com/E1i/mikoshi-construct/pull/198) [`4152fed`](https://github.com/E1i/mikoshi-construct/commit/4152fed85de999b07b439d5efeffcc6fc1577b22) Thanks [@E1i](https://github.com/E1i)! - contract: CI generates the base from the tag's code when the tag carries no surface of the current surfaceVersion; no CLI behaviour changes.

## 0.18.0

### Minor Changes

- [#186](https://github.com/E1i/mikoshi-construct/pull/186) [`714f2e1`](https://github.com/E1i/mikoshi-construct/commit/714f2e196210a8e49b6d32c05c1c9c5e358b4f83) Thanks [@E1i](https://github.com/E1i)! - `init` refuses a Node preset in a directory whose root has another ecosystem's manifest (`go.mod`, `Cargo.toml`, `pyproject.toml` and others) and no `package.json`. It names the preset and the manifest, writes nothing and exits 1. Until now it wrote the whole Node baseline into a Go repository and exited 0. `soulkill` reports the manifests it found on a new `Other stacks' manifests` line, and `--json` carries them as `existing.foreignManifests`.

- [#192](https://github.com/E1i/mikoshi-construct/pull/192) [`7e53958`](https://github.com/E1i/mikoshi-construct/commit/7e5395827511170d4dfd96cf77236e8b807dbe31) Thanks [@E1i](https://github.com/E1i)! - cli: `doctor --json`, `sync --json`, `sync --apply --json`, `cost --json` and `soulkill --json` carry a top-level `schemaVersion` (1), the version of that key set; `cost`'s `version` and `sync`'s `fromVersion`/`toVersion` still name CLI versions. With no `construct.json`, `doctor`, `sync` and `sync --apply` under `--json` now print `{ "schemaVersion": 1, "state": "no-manifest" }` instead of `null`, with the same exit code `1`: a script that tested for `null` tests for `state` being `"no-manifest"`. The key paths each of these outputs prints in each state are recorded in `contract/surface.json`.

- [#184](https://github.com/E1i/mikoshi-construct/pull/184) [`93327fd`](https://github.com/E1i/mikoshi-construct/commit/93327fd434ff4693544ad96f0dd4eb55ec6bd734) Thanks [@E1i](https://github.com/E1i)! - templates: the `/implement` ladder checks the base with the harness before its first rung. A red base stops the run as `base red` with the failure excerpt, and a verdict the schema rejects stops it as `base unverified`; neither runs an implementer or an architect. Every run now costs one more harness call.

- [#190](https://github.com/E1i/mikoshi-construct/pull/190) [`c8401f2`](https://github.com/E1i/mikoshi-construct/commit/c8401f2eaf6e8fe2c216ee1a2950eba41a195ab4) Thanks [@E1i](https://github.com/E1i)! - templates: `/implement` gains an eighth status, `stopped`, for a run stopped from outside before it returned. A ledger entry that ended without passing carries a `cause`: `stopped` takes `environment` or `human`, and `failed` takes `environment` or `task`. `construct cost` reads the following as malformed: a cause that belongs to another status, a cause on any other status, and a stopped entry with no cause. A failed entry with no cause reads as `not recorded`, so entries written before the field are kept as they are. A ledger entry may also name where its token figure came from with an optional `tokensSource` (`runtime`); without it, the figure is the Workflow tool's own report.

### Patch Changes

- [#187](https://github.com/E1i/mikoshi-construct/pull/187) [`bd1f32b`](https://github.com/E1i/mikoshi-construct/commit/bd1f32bfa22be9f6dc3d3ab41c0ebe463730d698) Thanks [@E1i](https://github.com/E1i)! - cli: the command-line surface (commands and aliases, flags, exit codes per command and state, format versions, the paths `init` and `attach` write, and the block markers) is recorded in `contract/surface.json` and compared with the code on every change. No command, flag, exit code or output changes.

- [#180](https://github.com/E1i/mikoshi-construct/pull/180) [`256fc30`](https://github.com/E1i/mikoshi-construct/commit/256fc30539ce4419b46d57f66a149f7024b64f3b) Thanks [@E1i](https://github.com/E1i)! - `soulkill` puts the pnpm version it finds on its own `CLI pnpm` line, saying it is the pnpm on the PATH construct runs with and was not read from the repository. The `Package manager` line now carries only what was read from the repository.

## 0.17.2

### Patch Changes

- [#178](https://github.com/E1i/mikoshi-construct/pull/178) [`3b5bccd`](https://github.com/E1i/mikoshi-construct/commit/3b5bccde04aab95f5fba1d4d71e4c4af58cdb8f6) Thanks [@E1i](https://github.com/E1i)! - The detected facts that `soulkill`, `inspect`, `capture` and `init` print label the Node major as `CLI runtime` and say it is the Node running construct, not something read from the repository. The line used to read `Runtime`, which looked like a fact about the project.

## 0.17.1

### Patch Changes

- [#173](https://github.com/E1i/mikoshi-construct/pull/173) [`030fc66`](https://github.com/E1i/mikoshi-construct/commit/030fc6645568030e28eb61c5b16ff8c7d530ffae) Thanks [@E1i](https://github.com/E1i)! - `construct detach` reads `recordVersion` in `.construct/attach.json` before anything else. A record written by a newer construct is refused with the same line a later `construct.json` gets, naming both versions. A missing or non-integer `recordVersion` is refused with its own reason. Nothing is removed in either case. Records written by this build are version 1 and detach exactly as before; until now, a record of any version was accepted without being checked.

## 0.17.0

### Minor Changes

- [#166](https://github.com/E1i/mikoshi-construct/pull/166) [`66597f2`](https://github.com/E1i/mikoshi-construct/commit/66597f230514519a1f0598e0269ebf0709446102) Thanks [@E1i](https://github.com/E1i)! - `construct attach` (alias `jack-in`): the reasoning-budget carriers for a repository the construct did not write
  
  A repository with its own agent configuration and often a different package manager can now take
  only the carriers of the reasoning-budget discipline — the `/plan` command, the `/implement` skill,
  the three agents and the ladder script — without a construct. `attach` writes those six files, hides
  them and `.construct/` through `.git/info/exclude`, and records what it created in
  `.construct/attach.json`: the harness command, the sha256 of each file, the directories it made and
  whether it created the exclude file. It never modifies a tracked file; `git status` is as clean after
  it as before.
  
  Seven refusals run before anything is written, in a fixed order, and each one creates nothing: no
  `.git`, a `.git` that is a file, a `construct.json` already here, a stack the detector does not
  recognise, a carrier path that already exists, `--yes` without `--harness`, and `--ai cursor` or
  `both`. Nothing is assumed about the harness: without `--harness` the command asks, and without a
  terminal it refuses.
  
  The carried commands read the record. The `/implement` skill takes `harness.command` from
  `.construct/attach.json` when there is no `construct.json`, the harness and architect agents accept a
  git toplevel that holds either record, and the ladder script no longer defaults the harness command
  to `pnpm run quality`: a run with no `args.harness.command` returns `blocked` with a question and
  calls no agent.
  
  The carriers are written exclusively (`wx`). A carrier that appears between the collision check and
  the write is never overwritten: attach removes what this run wrote, restores `.git/info/exclude` byte
  for byte and refuses with `COLLISION`.
  
  A later `detach` removes exactly what the record lists.

- [#167](https://github.com/E1i/mikoshi-construct/pull/167) [`edbb648`](https://github.com/E1i/mikoshi-construct/commit/edbb648d63c6b92761542bddf800c15545473e97) Thanks [@E1i](https://github.com/E1i)! - `construct detach` (alias `jack-out`): the inverse of `attach`
  
  Removes exactly what `.construct/attach.json` lists and nothing else: the recorded files whose bytes
  are still what attach wrote, the recorded directories that emptied, the block attach added to
  `.git/info/exclude`, and the record. Every read happens before any write. A carrier you committed
  with `git add -f` is adopted and stays; a carrier already gone is named; a carrier whose bytes changed
  refuses the whole run with nothing removed. A file attach did not write — the ledger
  `.construct/runs.jsonl`, a local `.claude/settings.local.json` — is never deleted and is named as left
  behind. There is no `--force`.
  
  The tracked set is read from `.git/index` directly, versions 2 and 3, `sha1` and `sha256`; the CLI
  still runs no `git`. Four index shapes are refused with their own reason before anything is removed:
  version 4, a split index, a sparse index, and an object format that is neither `sha1` nor `sha256`.
  
  Attach's rollback now removes the block it added to `.git/info/exclude` through the same inverse
  instead of restoring the file from memory, so a line appended into the file in the meantime survives.

## 0.16.4

### Patch Changes

- [#164](https://github.com/E1i/mikoshi-construct/pull/164) [`92c6be9`](https://github.com/E1i/mikoshi-construct/commit/92c6be9a3f15af4e0dc6bdbe403ba874f9a3ee67) Thanks [@E1i](https://github.com/E1i)! - The README names no version, and its opening paragraph says what the tool is today
  
  The front page opened with **v0.3.** while the published package was 0.16.x. Replacing the number
  would have been the wrong repair: nothing kept the claim true, so a correct number restarts the
  same decay from a later date. The defect is that the README asserts a fact it has no way to hold,
  and the fix has to remove the assertion or give it a source.
  
  Between the two shapes — the README naming no version, or the version rendered into it from
  `package.json` by a harness step — it names none. Nothing is lost by that: npm prints the version
  beside the README on the package page, the documentation site prints it, and `construct doctor`
  reports the version that materialized a given repository, which is the number a reader of a
  *repository* actually needs. A render script and a check would add a second producer of a fact
  three surfaces already publish.
  
  `tests/readme-version.test.ts` holds the property under either shape: every version-shaped claim in
  the README must equal the version in `package.json`. A README that names no version passes because
  it claims nothing; a rendered one would pass because it claims the right thing. The test also reads
  a claim out of a constructed sample and reads the token counts in the cost section as measurements,
  so it cannot pass by detecting nothing.
  
  The same paragraph was stale in content. It named the presets and `construct sync` alone, from when
  `sync` was the newest thing; there are six commands now, and it said nothing about the two records
  that carry what a repository is — `construct.json` for provenance, `construct.model.json` for
  knowledge — which is what discovery, `doctor` and `graph` stand on. It now names both and stays a
  paragraph.

## 0.16.3

### Patch Changes

- [#162](https://github.com/E1i/mikoshi-construct/pull/162) [`62d8a2a`](https://github.com/E1i/mikoshi-construct/commit/62d8a2aae889519b1fed22c99e6cd7f296d3d80b) Thanks [@E1i](https://github.com/E1i)! - An observation: a true output read for the wrong relation, and the refusal that ended it
  
  A false premise entered a task brief from the reviewing session, survived the owner re-running the
  command it rested on, and was stopped at the implementer by a measurement. `git tag | tail -3` was
  read as the three newest versions; it answers the last three lexicographically, and here those are
  `v0.8.0`, `v0.9.0`, `v0.9.1`, because `9` sorts after `1`. From that reading followed a count of
  untagged releases, a claim about what the release action pushes, and a claim that the header comment
  in `release.yml` is false — two briefed pull requests, and a correction drafted for a changeset.
  `git tag --sort=v:refname` ended it: 31 tags against 32 published versions, one gap at `0.1.0`, which
  is the version `release.yml` already documents as published by hand before trusted publishing could
  work.
  
  What makes the specimen worth recording is that the command succeeded. Its exit status was zero, its
  output was real, every tag it printed exists, and re-running it reproduced the same three lines. Only
  the relation between that output and the question was wrong. A failure would have announced itself;
  this did not, and the second run — by a second person — read as confirmation rather than as a
  repetition of the same reading.
  
  The entry states two readings and promotes neither. It is a third instance of a valid result read as
  evidence for a different relation, after `git ls-files` in decision 0014 and a commit range read for a
  temporal question; all three are git, in each case the default output answered an adjacent question —
  what is listed rather than what is tracked, ancestry rather than time, lexicographic rather than
  version order — and in each case a flag existed that would have answered the question asked. Three
  instances on one mechanism are material for the entry and are not grounds to extend anything, the
  trigger for that being a third instance on a different mechanism. And the carrier that stopped it was
  neither a check nor a rule but the implementer declining to write code from a brief that did not match
  the tree: the fourth refusal to build recorded here, and the first where the refusal kept a false
  statement out of a published record rather than out of an unbuilt artifact.
  
  No remedy is proposed and nothing is promoted to a decision or a rule. The boundary is one premise,
  one night, one project and three parties — a form, not a rate, and nothing about how often a true
  output is read for the wrong relation.

## 0.16.2

### Patch Changes

- [#160](https://github.com/E1i/mikoshi-construct/pull/160) [`9016086`](https://github.com/E1i/mikoshi-construct/commit/9016086ee04becc541abf1c33d9c3fcae89f521e) Thanks [@E1i](https://github.com/E1i)! - Two open questions: a check that can never be green, and a path that left no evidence
  
  `doctor` exits 1 on this repository for two conditions that are legitimate and permanent —
  `tsconfig.base.json` recorded in the manifest's `sync` branch and absent from the tree, and fifteen
  baseline files modified since `init`, which is what a repository that edits its own construct files
  looks like. Neither will become green, and a third condition — a real one — would arrive in the same
  exit code and go unread. A check that can never be green reports as much as one that can never fail.
  The question recorded is whether an owner can declare a construct-owned path they do not want, and
  files they maintain themselves, so that `doctor` can tell a declared deviation from an unknown one.
  
  The second question comes from the first one's evidence. Measured: the recorded hash `040735e3…` is
  byte-identical to `templates/harness/tsconfig.base.json`, and `git log --all --follow` over the path
  returns nothing, so git holds no evidence either way about whether the file was ever on disk here.
  Stated, not measured: the message of commit `9c00c33` says `--apply` wrote the path and that it was
  then deleted; the owner does not recall deleting it. A path `sync --apply` writes that git does not
  track leaves no evidence of having existed, so what the run did is recoverable only from prose — and
  the two kinds of claim above are why the entry keeps them apart rather than reading the message as a
  record of the action.
  
  Both are named and neither is answered. No design, no code, and nothing repaired: the `sync` record is
  a record of the past.

- [#155](https://github.com/E1i/mikoshi-construct/pull/155) [`9428ade`](https://github.com/E1i/mikoshi-construct/commit/9428ade0cec5f1e84971b03bbc07711efa34c1a8) Thanks [@E1i](https://github.com/E1i)! - Why a marker with no recorded provenance is not backfilled, said where the reader meets the gap
  
  `doctor` now reports markers that carry no recorded provenance, and the obvious next move — compute a
  sha over each body and write it down — is the one move that must not be made. A sha asserts that the
  body it hashes is what that run wrote. Computing one over a body nobody recorded asserts authorship of
  text whose author is exactly what is unknown, turning *never looked* into *checked and matching*: rule
  2 in the direction that manufactures support.
  
  `docs/cli.md` says this under the table of readings, so a reader who meets `unrecorded` there finds the
  reason rather than an apparent backlog. Provenance is written only by the run that writes the body: a
  discovery run records it for the markers it fills, a marker it did not fill keeps the entry it had,
  and `unrecorded` stays until a run rewrites that marker.
  
  This repository's own `open-questions` marker carries the question that leaves open, with its shape
  stated rather than a design proposed: the step that knows what body it wrote is a hand-written L0 step,
  and any command that records provenance after the fact is indistinguishable at the moment it runs from
  the laundering above. So an answer cannot be a command the owner runs afterwards — either the write
  happens inside the same act that authors the body, or it does not happen.
  
  No behaviour changes and no code changes; the nine markers stay unrecorded.

- [#157](https://github.com/E1i/mikoshi-construct/pull/157) [`ed97251`](https://github.com/E1i/mikoshi-construct/commit/ed9725181a5a62b3268030010be31e1f6320858d) Thanks [@E1i](https://github.com/E1i)! - Two pointers in this repository's own markers named a file that is not here
  
  `AGENTS.md` pointed at `docs/PLAN.md` twice — once in `module-map`, listing it among the directories
  the layout table does not cover, once in `high-effort-areas`, citing a section of it beside the
  discovery protocol. The file does not exist and is not tracked. Both pointers are removed and neither
  is replaced: what that file held now appears to live across `architecture/decisions/`,
  `architecture/observations.md` and `docs/guide/`, but that is an inference, and a marker is not the
  place for one. The sentences around them stand without a destination.
  
  Nothing else changes. Both markers carry no recorded provenance and still do.

- [#158](https://github.com/E1i/mikoshi-construct/pull/158) [`8d21eac`](https://github.com/E1i/mikoshi-construct/commit/8d21eacdb3746f9326f7e6b17784b62aef6d9212) Thanks [@E1i](https://github.com/E1i)! - Two source files imported across the dependency policy with no boundary to hold them to it
  
  `AGENTS.md` says dependencies inside `src/` point one way and that `eslint.config.mjs` enforces it.
  `ALLOWED_INTERNAL_IMPORTS` keyed a directory or file per module, and two files that import other
  modules had no key at all, so nothing was enforced for them: `src/failure.ts`, which reaches the
  vocabulary in `src/ui`, and `src/cli.ts`, which composes everything.
  
  The acceptance is the general property rather than the two files: **every source file that names an
  internal import is covered by a boundary.** It was run red first and named both — the second was not
  known before it ran. A file that names no internal import is asked for nothing, so `src/record-ahead.ts`
  and `src/version.ts` carry no entry and are not made to carry an empty one; that case ships as a test
  beside the criterion.
  
  The entries say what each file imports today, not what it might: `src/failure.ts` may reach `ui` and
  nothing that holds a record, and `src/cli.ts` may reach the commands, the presets, the vocabulary, the
  version and `detect`, but not the manifest, the model, the materializer or `sync` behind them. Both
  cases are in `tests/dependency-policy.test.ts`.
  
  No behaviour changes: nothing in `src/` moved, and the new rules are satisfied by the tree as it stands.

- [#159](https://github.com/E1i/mikoshi-construct/pull/159) [`6b22a07`](https://github.com/E1i/mikoshi-construct/commit/6b22a0736936b16d9e6f0831bb3505f12c3905f4) Thanks [@E1i](https://github.com/E1i)! - An open question: the machine-readable output declares nothing and refuses nobody
  
  `construct.json` declares `manifestVersion` and `construct.model.json` declares `modelVersion`, and each
  refuses a record written by a later build through one shared error. `doctor --json` declares nothing:
  `src/cli.ts` serialises `DoctorResult` as it stands, so the output carries no statement of what it is
  and there is nothing for a reader to check or for the tool to refuse. A consumer matching a value that
  has since changed — `authorship: "unknown"`, which 0.16.1 no longer emits — receives no error; its
  branch simply stops firing.
  
  The question is recorded in this repository's `open-questions` marker with the measurement behind it:
  nothing the construct materializes calls `doctor --json` — not the templates, not the workflows, not
  `construct-discover.md` — and every match outside the source is built documentation or release-note
  prose. The consumer count is zero today, and that is what makes an answer cheap now rather than what
  makes it unnecessary.
  
  No design is proposed and no code changes.

## 0.16.1

### Patch Changes

- [#151](https://github.com/E1i/mikoshi-construct/pull/151) [`2cf0662`](https://github.com/E1i/mikoshi-construct/commit/2cf0662376e9ba8ef3532ed948343cc572c8be23) Thanks [@E1i](https://github.com/E1i)! - Release verification says which of three states left the version absent, and derives the third
  
  `mikoshi-construct@0.15.0` was versioned and never reached the registry. Release verification caught
  it, which is what it is for. Its message then named two causes — a staged publish awaiting approval,
  or a publish that failed while reporting success — and prescribed the repair for the first:
  `npm stage approve`, then re-run. The real cause was neither. The release action had found an
  unconsumed changeset in `.changeset/` and updated the version pull request instead of publishing, so
  there was nothing staged to approve and nothing to re-run. Every fact in the line was true and it
  pointed the reader at a repair that does not exist for the state they were in.
  
  **Three states produce the identical 404**, and they take three different repairs: approve the staged
  version, read the failed publish's log, or consume the changesets and release again. The message now
  names all three and prescribes none of them while the state is undetermined — the reader is told what
  tells them apart, not what to do before they know which one they have.
  
  **The third is not one of three guesses, because it is readable.** Which branch the release action
  takes is decided by the tree it runs on: unconsumed changesets in `.changeset/` mean it versions
  rather than publishes. The verification checks out that tree to read the version it is verifying, so
  it reads the directory from the same checkout and states the cause, with the count and the filenames
  that carry it. A tree with nothing pending excludes that state instead, and two are named rather than
  three.
  
  **Boundary.** The reading is of the tree the verification checked out, and it says so in those terms.
  A changeset merged after a successful publish, while the registry is still catching up, would be read
  as versioning; the window is the poll's two and a half minutes and the claim stays scoped to what was
  seen. Nothing about the exit codes changes: absent is still 1, unreachable still 2, and unreachable
  still claims nothing.

- [#154](https://github.com/E1i/mikoshi-construct/pull/154) [`424df7f`](https://github.com/E1i/mikoshi-construct/commit/424df7f9b851296b87b52cfc90d3c0349593570e) Thanks [@E1i](https://github.com/E1i)! - Discovery provenance reports every state it computes, and the three causes of "unknown" become three states
  
  `doctor` derived four things about a discovery marker and printed one. `markerAuthorship` answered
  `unknown` for three different causes — the marker was never construct-authored, no sha was ever
  recorded, and the body could not be read — and the report then kept only the markers still reading
  back what discovery wrote and returned early when that list was empty. So `owner`, the one state the
  sha exists to surface, was computed on every run and never printed, and a marker whose provenance was
  never recorded was indistinguishable from one the owner had rewritten.
  
  Measured on this repository before anything changed: nine of ten markers recorded as `unknown` with no
  sha, one recorded as construct-authored whose body no longer hashes to its recorded sha. `doctor`
  printed no provenance section at all.
  
  **The incoherent record is now unconstructable rather than handled.** `MarkerProvenance` is a union of
  the two combinations that can occur — `construct` with the sha of the body that run wrote, or
  `unknown` with `null` — so `construct` with no sha cannot be expressed. `upgradeManifest` is the one
  door such a record can arrive through, and it reads it back as `unknown` with `null`. That removes one
  of the three causes at the type level and leaves two real states, which is why `authorship` has four
  members and no flag:
  
  | reading | what it means |
  |---|---|
  | `construct` | recorded, and the body still hashes to the recorded sha |
  | `owner` | recorded, and the body no longer matches: edited since, and read as the owner's |
  | `unrecorded` | nothing was recorded, so there is nothing to compare a body against |
  | `unreadable` | recorded, and the body could not be read here |
  
  The report renders each of them from one table keyed by the reading, so a state added later has
  nowhere to be silently dropped, and the section is omitted only when there is no marker at all. On the
  repository above it now names the edited marker as the owner's and says that nine carry no recorded
  provenance.
  
  **`authorship` in `doctor --json` no longer emits `unknown`**; it emits `unrecorded` or `unreadable`,
  whichever the reading was. Nothing else about the output changes, and provenance still never changes
  the exit code.
  
  The nine markers are left without shas: recording them is a separate change, and doing it here would
  have removed the state this was measured against.

- [#152](https://github.com/E1i/mikoshi-construct/pull/152) [`c4411fb`](https://github.com/E1i/mikoshi-construct/commit/c4411fb11ccca58e17d73f38da4b1fd48cf717a5) Thanks [@E1i](https://github.com/E1i)! - Two observations: the cells of a blind discovery run, written before it, and what the run produced
  
  A copy of this repository was taken before either record existed, to ask whether the discovery
  protocol surfaces a form stated nowhere in the tree: *an assertion that cannot be subjected to a
  meaningful attempt to refute it is a declaration, not a check*. The tree carries an instance of that
  form — decision 0027, on acceptance criteria, rendered in three further files — and an adjacent
  generalisation in decision 0024 and in observations.md. The prescribed reading surface of
  `.claude/commands/construct-discover.md` names none of them.
  
  The first entry fixes the four cells before the run: what a hypothesis matching the form would mean
  with the carriers unread or opened, and what its absence would mean in each case. Two readings are
  stated plainly there because both were got wrong on the way to writing them — that a protocol which
  does not prescribe a file is not an agent failing to read it, which is why the run asks for the list
  of files actually opened, and that a hypothesis matching the form is attributable to independent
  discovery only if that list shows every carrier unread.
  
  The second entry records the outcome. In one blind run the protocol produced four new instances of
  the form — three in the enforcement plane, one in verification — and did not state the form as a
  general property; no carrier of it was opened. The cells were binary on whether a hypothesis
  appeared and had nowhere to put four instances written without the generalisation, which is recorded
  rather than adjusted. No mechanism is offered for why the form was not stated. A second run by a
  different tool is excluded as invalid rather than counted as a negative result, and one of the four
  instances — nine of ten discovery markers carrying no recorded provenance — is left unrepaired on
  purpose, because repairing it would have changed the specimen.
  
  Neither entry is promoted to a decision or a rule. The boundaries are one run, one specimen, one
  protocol, and an agent of the same lineage as the one with which the form was first stated.

- [#151](https://github.com/E1i/mikoshi-construct/pull/151) [`2cf0662`](https://github.com/E1i/mikoshi-construct/commit/2cf0662376e9ba8ef3532ed948343cc572c8be23) Thanks [@E1i](https://github.com/E1i)! - 0.15.0 and 0.16.0 each carry a dated notice naming the other
  
  The changelog asserts that 0.15.0 is a release. It is not: no tag, nothing on the registry. Under
  [0021](https://github.com/E1i/mikoshi-construct/blob/main/architecture/decisions/0021-a-record-of-the-past-is-not-edited.md)
  the entry is not corrected — it records what was versioned, and that did happen — so a dated notice is
  added beside it instead, and the entry is left as it was written.
  
  **The notice is written in both directions, and the more important one is on 0.16.0.** A reader
  arrives at the version they installed, not at the one that does not exist: someone on 0.16.0 sees an
  entry naming a single pull request and has no way to learn that two more shipped inside it. So 0.16.0
  says it carries what is listed under 0.15.0, and 0.15.0 says its changes went out as 0.16.0. This is
  0021's own remedy for a stale record — a pointer from the old statement to the new one — applied to a
  pair rather than to one file.
  
  A notice is parsed out of the changelog rather than kept in a second list, and a test fails when one
  points at a version that answers nothing back, so the pair cannot be half-written. The rendered
  release-notes page carries both, because it is generated from the changelog.

## 0.16.0

> **Recorded 2026-09-22 — this release also carries the work versioned as 0.15.0.** The entry below
> names only what 0.16.0 versioned itself. Everything listed under 0.15.0 is in this release too:
> that version was versioned and never published, so if you installed 0.16.0, read the 0.15.0 section
> as part of what you have.

### Minor Changes

- [#149](https://github.com/E1i/mikoshi-construct/pull/149) [`fda1950`](https://github.com/E1i/mikoshi-construct/commit/fda19505c9cb9c21df8b7924eb18925c96cf1d76) Thanks [@E1i](https://github.com/E1i)! - `/plan` in Claude Code requires a criterion to be seen failing before the change
  
  The plan command asked for acceptance criteria a harness run or a test can confirm, and for each
  criterion to be verified by what the task changes itself. Both are satisfied in full by a criterion
  that has never been shown failing, so a task could carry four criteria, all of them green from the
  first moment, none of them able to tell a change that worked from one that was never needed. The
  command now asks for the criterion to be run and seen failing first.
  
  **It is scoped, and the scope is the point.** The requirement reads *where a criterion can fail
  against the repository as it stands*. A criterion for a defect or for absent behaviour can; one
  written to forbid a wrong implementation cannot, and the command says nothing about that case in
  either direction. Stating the wide form would have a planning agent reject a legitimate guard;
  stating the narrow form as universal would do the same. Silence here is the honest state of a
  question that is open.
  
  **This is not enforcement, and the distinction is worth reading slowly.** What changes is that the
  rule reaches the planning command in Claude Code — not planning in general, and not Cursor, which
  this tool gives no `/plan` equivalent. The instruction is prose an agent may or may not follow —
  L0 on the scale this tool reports, exactly like the discovery protocol, and nothing reports a
  violation of it. The carrier is the evidence a run leaves behind, and it is not built here. Anyone
  reporting this release as *the rule now works* is making a claim wider than what was done.

## 0.15.0

> **Recorded 2026-09-22 — versioned, never released.** No `v0.15.0` tag exists and the registry has
> never served this version. The release run on the version commit found an unconsumed changeset in
> `.changeset/` and updated the next version pull request instead of publishing — nothing was staged
> and nothing failed, the publish never ran. The changes below reached the registry in 0.16.0. The
> entry itself is left as it was written.

### Minor Changes

- [#146](https://github.com/E1i/mikoshi-construct/pull/146) [`4dd1b57`](https://github.com/E1i/mikoshi-construct/commit/4dd1b57e35605358a5e315c1bdc9d4ae7108a41e) Thanks [@E1i](https://github.com/E1i)! - A construct.model.json from a later build is a named state, not a schema failure
  
  A model declaring a `modelVersion` this binary does not understand produced a generic parse failure —
  the same path as a missing field or a malformed array. It is now reported as what it is, with the
  record, the field and both versions, and the command exits `1` without reading or writing anything.
  `doctor`, `graph`, `sync` and `init` all inherit it, because all four read the model.
  
  **The state was not built twice.** One already existed for `construct.json` and everything about it
  fitted except that the error and its line named that file and that field in their own text. The
  carrier now takes the record and the field as values and both readers raise it, so there is one
  mechanism rather than two of the same shape. A manifest from a later build reports exactly the text it
  reported before.
  
  The check also runs before the unknown-property check, since a model from a later build will usually
  carry fields this binary has never seen and the symptom would otherwise be reported instead of the
  cause.
  
  **What it closes.** `readModel` returns `null` when the file is absent, and `null` already means *no
  model*, which `doctor` explains by saying `construct init` writes one. Had a version-ahead model
  collapsed into that reading, `doctor` would have told someone holding a newer model to run `init` —
  proposing to overwrite the file it had just failed to read.
  
  Nothing migrates an older model, no fact kind is added, and `MODEL_VERSION` does not move.

### Patch Changes

- [#148](https://github.com/E1i/mikoshi-construct/pull/148) [`70f8c07`](https://github.com/E1i/mikoshi-construct/commit/70f8c0796a40ab1a879f2ad5a650410e9d6df155) Thanks [@E1i](https://github.com/E1i)! - An observation: an acceptance played a second role at 0027's first use
  
  Decision 0027 requires an acceptance to be red on the current tree before the implementation exists.
  Its first application — decision 0028 — carried two axes, and only one behaved that way. The second
  was green and could not have been red, because the defect it describes does not exist on that tree;
  it becomes red only against a specifically named wrong implementation, which is what it was run
  against.
  
  So an acceptance has two legitimate roles and the rule describes one: detecting an existing defect,
  which is red on the current tree, and forbidding a named wrong fix, which never is. The second needs
  a clause the first does not, or it is satisfiable by construction — the named wrong implementation
  must be one a reasonable implementer would actually reach for. Here it was the one the task brief
  itself described as the current state.
  
  The entry does not extend 0027. Whether "red on the current tree" should become "red on the current
  tree, or against a plausible named wrong implementation" is named and left open on one application
  and one gap, with the trigger stated: a second acceptance that turns out to be a guard against a
  wrong fix, in an unrelated task.

## 0.14.1

### Patch Changes

- [#145](https://github.com/E1i/mikoshi-construct/pull/145) [`71ff5d2`](https://github.com/E1i/mikoshi-construct/commit/71ff5d2fc583b44924a2f1f78365e1f023af3935) Thanks [@E1i](https://github.com/E1i)! - Decision 0027: an acceptance is red before the implementation exists
  
  The lifecycle had an unnamed stage between the brief and the implementation, and it had been doing
  real work. It is acceptance discipline, and it is not the reasoning ladder: one answers whether we
  may proceed to reasoning at all, the other how much reasoning to give once the harness says the
  solution does not work. A new normative area takes a new number rather than widening the ladder into
  a job it never had.
  
  The rule is one mechanical test. A criterion that cannot be shown failing is a statement of intent
  however specific its wording, and the discriminator for every checkpoint in the stage is that it is
  met by producing something a second party can check rather than by an answer about one's own work.
  Two stops come with it — a baseline that cannot be reproduced is reported rather than assumed, and a
  criterion is never adjusted to make the test green — and one condition, that the party writing the
  acceptance is not the party measuring it.
  
  `the-cycle.md` §3 keeps both of its existing rules, which the record names individually: the first
  bounds what a criterion may depend on and survives untouched, the second orders tasks and is not
  about criteria at all. Neither provides red-before-implementation, so the third statement lives in
  the decision and §3 points at it.
  
  The record carries L1 and says why: nothing today can report a violation, so by this repository's own
  observation it is a rule carried by memory. What would make it L3 is named and not built.
  
  The record carries two things a later reader would otherwise have to rediscover. The chain of
  carriers has a stated end — it stops at the first level where enforcement can fail without a human
  deciding it has failed, and where that failure has been demonstrated on a real case the carrier was
  expected to catch — with both clauses shown against examples already here: the dependency audit under
  `continue-on-error` fails the first, and the post-publish smoke satisfies the second by having been
  run red on 0.12.2 and green on 0.13.0. And the path to enforcement is written as three rungs rather
  than one, because the middle rung — the planning agent reading the rule — is necessary, is still L0,
  and is the one that will be reported as completion.

- [#143](https://github.com/E1i/mikoshi-construct/pull/143) [`f7c9da5`](https://github.com/E1i/mikoshi-construct/commit/f7c9da573059901c869e9f205a4c1054fd00bfdb) Thanks [@E1i](https://github.com/E1i)! - Three observations: rules without carriers, plans that ended in not building, and six stops on a false premise
  
  **A rule with no independently checkable carrier is carried by memory.** Two rules stated clearly and
  observed by whoever remembered them: the documentation claim that stood ten minor versions, and the
  reasoning ladder, whose only artifact is a ledger line recorded for 29 of 65 runs. What they share is
  not that they were broken but that breaking them produces nothing, so the absence of complaints is
  evidence about the reporting rather than about the rule. The rule was considered for promotion to a
  numbered epistemic rule and was not promoted, because it fails its own requirement — nothing would
  exist if it were broken.
  
  **Three plans that ended in not building, each with its reason recorded.** The discovery plan skill,
  whose hand-written plan came out empty; the trace of an unmade claim, which 0020 left open and 0024
  answered by refusing to record one; and the rule above, which declined its own promotion on the
  standard it proposes. None was dropped quietly, each reason is specific to the thing, and in each
  case the output was a record rather than the artifact.
  
  **Six stops on a false premise, in one night.** Each premise as stated, and what measurement showed.
  Five were the reviewing session's and one the implementing session's. The condition that makes it
  work is that in all six the party who wrote the criterion was not the party who measured it.
  
  All three carry their boundary: a form, not a rate, and none of them says how often any of it
  happens.

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

[0.5.0 — the tool stops asserting what it cannot show](/release-notes/0.5.0)

## 0.4.0

[0.4.0 — a number is worth what its counting method is worth](/release-notes/0.4.0)

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

[0.3.0 — a claim is worth what its enforcement is worth](/release-notes/0.3.0)

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

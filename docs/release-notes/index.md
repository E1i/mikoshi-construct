# Releases

Every released version, generated from [CHANGELOG.md](https://github.com/E1i/mikoshi-construct/blob/main/CHANGELOG.md).
Edit the changesets, then run `pnpm release-notes:render`; the test suite fails when this page and the
changelog drift apart. A release with a hand-written note links to it rather than repeating it here.

## 0.44.0

### Minor Changes

- [#906](https://github.com/E1i/mikoshi-construct/pull/906) [`83c4d2d`](https://github.com/E1i/mikoshi-construct/commit/83c4d2d35325570d43173cab3f1b1940939553b7) Thanks [@E1i](https://github.com/E1i)! - templates: the acceptance build in `scripts/construct/check-acceptance.mjs` now refuses a brief whose Acceptance or Invariants items were not split where the author meant. An item that holds more than one `— witness:` marker is refused, because the build splits items only on `;` and such an item would be checked by its last witness alone. An item that begins with a command continuing the witness before it is refused too, because a `;` between two witness commands cut it off its own item. Each refusal names the item and says how to write it: end each item with `;`, and give each witness command its own item. Before this, such a brief built and its ladder ran on fewer items than the brief listed

- [#945](https://github.com/E1i/mikoshi-construct/pull/945) [`a989b0b`](https://github.com/E1i/mikoshi-construct/commit/a989b0b8b209618f4a9cac0256f7630a0fa21366) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake --admit <parking>/<id>.md`, when the bus is wired and the file is not in the parking, reads the card's body from the bus (the text its last admission recorded). It writes no file back into the parking.

- [#726](https://github.com/E1i/mikoshi-construct/pull/726) [`9796252`](https://github.com/E1i/mikoshi-construct/commit/9796252ca2b12e70b77ea015cf3ddeabe9961532) Thanks [@E1i](https://github.com/E1i)! - cli: `construct atlas` draws a map you can click: the contours your repository declares at the top, at most 30 nodes at first sight, a click unfolding a contour into components and a file into its relations with path:line, arrows counting the relations under them and marking those that bypass a declared entry; templates: discovery names the components of each contour in the Engram's `interpretation` layer, and the Engram is `modelVersion` 6

- [#749](https://github.com/E1i/mikoshi-construct/pull/749) [`9eb0012`](https://github.com/E1i/mikoshi-construct/commit/9eb0012af38d6b2e13757f47d2a7c445ff5a9c2c) Thanks [@E1i](https://github.com/E1i)! - cli: `construct atlas` shows the entry points of a repository — its `package.json` scripts, workflow steps and Claude Code hooks — each linked to the files its command names, and candidate file channels — a module that calls a `node:fs` write and a module that calls a `node:fs` read, joined because both name the same file name, not traced to the call — with `path:line` on both sides; the Engram records them as `runs`, `writes` and `reads` relations beside `imports` and `calls`

- [#1067](https://github.com/E1i/mikoshi-construct/pull/1067) [`8bcd951`](https://github.com/E1i/mikoshi-construct/commit/8bcd951ed18be7969c12ececa3760a4906aaa5c5) Thanks [@E1i](https://github.com/E1i)! - `construct atlas`: the map and the docs pages have a new look. Each page now opens with a top bar (the MIKOSHI atlas · engine mark, the Map / Docs switch and a ◐ theme button) and a header naming the repository, with counts of contours, parts, files, read and unread files, entry points and relations, and a bar showing the share of files read. The map sits in a Map panel with search, edge filters and sorting, a canvas and an inspector that shows a hint until something is selected, followed by a Legend panel and a status line. The docs page uses the same style. The pages are dark by default and light when the system prefers light; the ◐ theme button switches between the two and remembers the choice. Both pages still fetch nothing: the fonts are system fonts, and the theme switch runs inside the one script whose hash the page's Content-Security-Policy names. The map page no longer draws the stage columns or their second legend; the stages are read on the docs page.

- [#920](https://github.com/E1i/mikoshi-construct/pull/920) [`fe99ce0`](https://github.com/E1i/mikoshi-construct/commit/fe99ce00ba53f06a511204c8e461d15a836d258b) Thanks [@E1i](https://github.com/E1i)! - cli: the `construct atlas` map reads as a selection, a filter and a search. A selected node lights its edges and neighbours and dims the rest. Each edge kind can be hidden from the legend and shown again, and a note names every hidden kind. A folded group or contour keeps its `bypass` or `unknown` mark under every filter. Search finds contours, parts and entry points as well as files, and opens and centres what it finds. The parts inside a contour sort by name, edge count or state. Edge labels show on hover, on the selection and when zoomed in. On a narrow page the side panel floats over the map

- [#962](https://github.com/E1i/mikoshi-construct/pull/962) [`4fc45af`](https://github.com/E1i/mikoshi-construct/commit/4fc45af894a86439c8549bcd429e7fa50e46dfe3) Thanks [@E1i](https://github.com/E1i)! - cli: a `construct atlas` source link opens in an editor or on the remote instead of as a raw file. Set `"atlas": { "open": "vscode" }` in `construct.json` (or `cursor`, `zed`, `idea`, or a template such as `vscode://file/{abs}:{line}`) and the map opens each file at its line in that editor; the absolute root is worked out in the browser from where the page lies, so no path of the machine is written into the page. Without a template, a GitHub or GitLab remote gives `{remote}/blob/{sha}/{path}#L{line}`, read from the repository's git files with no `git` process; with neither, the link stays relative as before. The docs page opens with a summary of parts and bound files, shows each part in order with what it does, its links and its code folded as a folder tree, and folds the code no part claims into a folder tree with the one command that binds it, `/construct-discover`. With no part in the Engram yet, the docs page builds its parts from the packages and directories the code declares; with no model at all it says so and names the command that starts one

- [#947](https://github.com/E1i/mikoshi-construct/pull/947) [`b49c071`](https://github.com/E1i/mikoshi-construct/commit/b49c07126bb1528fc4a31f7b9df787b2d4f49acc) Thanks [@E1i](https://github.com/E1i)! - `construct atlas` now refuses a repository that has neither a `construct.json` written by `construct init` nor an attach record, writes nothing, and exits 1 with a line that names `construct attach` as the way in. Before this it wrote an Engram and a page under the home directory for any repository at all. A repository attached by this build runs as before: a test now holds that `construct attach` on a foreign repository leaves every tracked file byte for byte as it was, an existing `construct.model.json` included, which is what lets the Atlas run there.

- [#1073](https://github.com/E1i/mikoshi-construct/pull/1073) [`898413c`](https://github.com/E1i/mikoshi-construct/commit/898413ccccd8dc2c72a744d0a61113128fbd1322) Thanks [@E1i](https://github.com/E1i)! - `construct atlas`: the header of the map and the docs pages names the repository and describes it, and says where each came from. The name is the `name` in `package.json`, else the first `#` heading of the README, else the folder name, else "unknown repo"; the description is the `description` in `package.json`, else the first paragraph of the README, else nothing. Before, the header showed only the folder name.

- [#680](https://github.com/E1i/mikoshi-construct/pull/680) [`fa58d2f`](https://github.com/E1i/mikoshi-construct/commit/fa58d2f09d5823c12d35ed117b1d298df14df3f4) Thanks [@E1i](https://github.com/E1i)! - attach record v3: harness may be none; an older build refuses to detach it

- [#1077](https://github.com/E1i/mikoshi-construct/pull/1077) [`c31a55d`](https://github.com/E1i/mikoshi-construct/commit/c31a55d52d0ddc8f0257771072cdce71ea335673) Thanks [@E1i](https://github.com/E1i)! - `construct attach` now also writes `.construct/window-hooks.mjs`, a self-contained hook script, and registers it in `.claude/settings.local.json` next to the commit guard: a `Stop` entry that keeps a tab window going while its handoff ends `STATUS: CONTINUE`, a `PreCompact` entry that names a stale handoff, and a `SessionStart` entry for `compact` that tells the compacted session which handoff to continue from. `construct detach` takes the three entries and the script out again, and gives back a settings file that existed before attach byte for byte. The attach record is now `recordVersion` 4.

- [#1036](https://github.com/E1i/mikoshi-construct/pull/1036) [`e538278`](https://github.com/E1i/mikoshi-construct/commit/e53827865ed18c2312930a9827a6de611b3a65bb) Thanks [@E1i](https://github.com/E1i)! - cli: `construct board` opens with one line per open plan, read from the plan journal in the bus instead of a release number guessed from card text: `<plan>: delivered N of M · queued · in progress · review · slices without cards: K · +X in 24 h · backlog: B`. A slice counts as delivered only when every card linked to it is merged; a dropped card does not count, a second card on one slice does not grow the total, and a card linked to no slice is in the backlog. A closed plan leaves the board. A bus with no open plan shows no plan line.

- [#986](https://github.com/E1i/mikoshi-construct/pull/986) [`b8b1f4f`](https://github.com/E1i/mikoshi-construct/commit/b8b1f4fabd07923a08995bf61cf5b40d28ceb931) Thanks [@E1i](https://github.com/E1i)! - cli: `construct board` opens Flow with the goal line, `goal · release 0.44 · — · N of M merged`: the release that owner decision D-193 names, and how many of the cards whose `Path (D-76):` line names that release are merged, out of all of them except the dropped; with no such decision in the bus the line is absent

- [#922](https://github.com/E1i/mikoshi-construct/pull/922) [`8c7deff`](https://github.com/E1i/mikoshi-construct/commit/8c7deff0b500c018dba01edb65f4554c2d404024) Thanks [@E1i](https://github.com/E1i)! - cli: `construct board` reads the bus and shows Flow, Backlog with swimlanes by lane, and Services with the step each task is at, under a header with the version and the mode; `--geek`, `--prs`, `--all` and a non-default `--stale` show the raw ledger and pull request sections instead, `--json` stays the raw board and does not read the bus, a window subagent with no recorded end drops out of Services after 12 hours, and the start hint now says Miko chooses how each task runs

- [#948](https://github.com/E1i/mikoshi-construct/pull/948) [`9f3398b`](https://github.com/E1i/mikoshi-construct/commit/9f3398b9e82e8f84a551da89efe2108820a560a0) Thanks [@E1i](https://github.com/E1i)! - cli: `construct board` shows, under Services, the latest check matrix the bus holds for each pull request — killed, survived and not run at its head, or why it was a full run

- [#966](https://github.com/E1i/mikoshi-construct/pull/966) [`ff7e6ff`](https://github.com/E1i/mikoshi-construct/commit/ff7e6ff2676bb7427c22d25cb63789f5bfba7963) Thanks [@E1i](https://github.com/E1i)! - cli: `construct board` shows only live cards in Flow and Backlog — a card with no card body, or one closed through `task:close`, is not in work, and a card dropped, merged or closed more than 12 hours ago appears in Backlog only under `--all`, which now keeps the screens instead of switching to the raw sections; Services also names the window's role record and each session's step with its pulse, a card's check matrix stands beside it in Flow, and a lost session counts as the last failure

- [#938](https://github.com/E1i/mikoshi-construct/pull/938) [`5fc8c7a`](https://github.com/E1i/mikoshi-construct/commit/5fc8c7a2ce198483120b613b75a705ec757a57a6) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake` run without `--parking` now places each card it writes in a lane of the parking. A card goes to the lane that holds a card it depends on. Otherwise it goes to the first lane whose touches overlap its own; a lane's touches are those its `lane.json` lists plus those of the cards parked in it. Otherwise intake opens a new `lane-NN` and writes its `lane.json`. The `card.admitted` event names that lane. With `--parking`, the card is written to that directory as before.

- [#804](https://github.com/E1i/mikoshi-construct/pull/804) [`dceeb64`](https://github.com/E1i/mikoshi-construct/commit/dceeb64b0faee8c7e7a2c5dd37994e9a1a83eaea) Thanks [@E1i](https://github.com/E1i)! - `construct intake` reads a `depends` or `blocks` as merged from a journal merge line written before `2026-10-12T17:04Z`, or from a card the bus a caller wires in holds `merged` or `closed`; when a caller wires a bus in, a journal line written after that time counts only through it.

- [#930](https://github.com/E1i/mikoshi-construct/pull/930) [`dc8c354`](https://github.com/E1i/mikoshi-construct/commit/dc8c35420c21142284b095cfd434c0c8f70c17b4) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake` now turns the slices it proposes into cards. Each `slice:` line ends with `· depends N` when a file in that slice has a relative import of a file in slice N. Intake reads those imports from the repository given by `--dir`. A card with proposed slices waits for `--confirm`. Once confirmed, intake parks one card per slice instead of the whole card. Each slice card is named `<name>-slice-<n>` and gets its own number. Its depends come from the import order between slices, and its body says `whole: slice <n> of <name>`, so it is not held for slicing again. A slice card keeps the card's witnesses that name one of its test files. A witness that names a test of no slice goes to every slice. A slice left with no witness keeps all of them and is marked unclear. Intake refuses a card whose slices import each other, because no order of their cards holds. A card the complexity seam flags with no slices to offer is no longer held at `who: window`.

- [#809](https://github.com/E1i/mikoshi-construct/pull/809) [`b390962`](https://github.com/E1i/mikoshi-construct/commit/b39096247407c8b4ebcbf106c3a69f6ad273f7d4) Thanks [@E1i](https://github.com/E1i)! - `construct cost` counts a cheap task closed in the window journal only when its closing line was written before `2026-10-12T17:04Z`; a later one is left out of the cheap forecast, and the class names how many were left out and why. `construct cost` reads no bus.

- [#1047](https://github.com/E1i/mikoshi-construct/pull/1047) [`752bfc0`](https://github.com/E1i/mikoshi-construct/commit/752bfc0fb6d1d638cc2208d8a7f6f191cbac91a8) Thanks [@E1i](https://github.com/E1i)! - cli: `construct cost` no longer opens `~/.construct/handoff/ghosts.jsonl`. The cheap forecast reads the window's journal half of history from the legacy lines of the bus database (`CONSTRUCT_BUS_DB`, default `~/.construct/bus.db`), and counts every session a closed card's `card.started` and `card.answered` events name, its minutes from the first start. `cheap.windowJournal` in the cost report is now `cheap.bus`.

- [#907](https://github.com/E1i/mikoshi-construct/pull/907) [`a62af93`](https://github.com/E1i/mikoshi-construct/commit/a62af93688c9291d05cbfca19037d0dcb4c71e57) Thanks [@E1i](https://github.com/E1i)! - cli: `construct cost` takes a closed cheap card from the cards and card_bodies projections and its start and close events in the bus database (`CONSTRUCT_BUS_DB`, default `~/.construct/bus.db`), so cards closed after the journal half of history ends are counted instead of reported as not read. The minimum Node rises from 20 to 22.13.0, the first 22.x release where `node:sqlite` loads without a flag.

- [#705](https://github.com/E1i/mikoshi-construct/pull/705) [`226a3d9`](https://github.com/E1i/mikoshi-construct/commit/226a3d9abb1ff838c608c0fb36f4c551e21bbbfd) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake --draft` and `--admit` derive a card's decision from `architecture/owner-merges.md` — a touch that meets an owner glob makes it `owner`, otherwise `auto` — and `--admit` refuses a hand-written `owner` on a card that touches no owner path, naming it, until the token it prints confirms `auto`; a repository without that file keeps the card's own decision

- [#980](https://github.com/E1i/mikoshi-construct/pull/980) [`cf4ee6e`](https://github.com/E1i/mikoshi-construct/commit/cf4ee6ea4525032c9d19e14ebeefac07892ac9b4) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake --move <card> --to archive|dropped|superseded` is a drop: the bus holds it as `card.dropped`, a transition of the card automaton, instead of `card.moved`, and the printed line names the event the bus holds. A parked card the bus never admitted can now be dropped; a move into any other directory still refuses such a card. A dropped card is no launch candidate and holds neither its lane nor its touches, including a ladder card waiting on its Ghost review.

- [#1093](https://github.com/E1i/mikoshi-construct/pull/1093) [`1e54d3c`](https://github.com/E1i/mikoshi-construct/commit/1e54d3c5ba61fcdbdbd2a520394105e1e60a56e1) Thanks [@E1i](https://github.com/E1i)! - The package now carries the factory as built JavaScript: every module that the bus, shift, ghosts, miko, decisions and owner scripts load, spawn or read beside themselves, under `dist/scripts/**` and `dist/src/**` at the paths they have in the repository, with the data files they read copied beside them. A factory entry runs with plain `node` from an installed package, without tsx and without devDependencies, for example `node dist/scripts/bus/reducer.js`. New command `construct say "<words>"`: the owner's words, written as one unused answer into `~/.construct-owner/answers/`, the channel an owner decision is accepted from. No published command starts the factory yet.

- [#1096](https://github.com/E1i/mikoshi-construct/pull/1096) [`40e4ec5`](https://github.com/E1i/mikoshi-construct/commit/40e4ec5e9d58122f70cefffbad7269eddf878710) Thanks [@E1i](https://github.com/E1i)! - New bin `construct-factory`: run in your repository, it starts the factory from the installed package — the bus, its switched-on workers and their supervisor, each as `node` on its built file and detached so it survives closing the terminal — and on macOS installs a per-user launchd agent that keeps it running for that repository; the factory's own checkout keeps its own agent and gets none.

- [#1076](https://github.com/E1i/mikoshi-construct/pull/1076) [`7753659`](https://github.com/E1i/mikoshi-construct/commit/775365997912746bad55f0cf905150c2e62b64f5) Thanks [@E1i](https://github.com/E1i)! - `init` and `attach` now ask how many parallel lanes the bus runs, default 3, and take `--lanes <count>` instead. `init` records the answer as `lanes` in `construct.json`; `attach` records it as `lanes` in `.construct/attach.json` and still writes no `construct.json`, so `doctor` and `sync` keep reading an attached repository as attached. A second `init` reads the recorded count and does not ask again. The bus takes its lane count from `construct.json`, else from the attach record, else 3.

- [#1092](https://github.com/E1i/mikoshi-construct/pull/1092) [`b8fb87f`](https://github.com/E1i/mikoshi-construct/commit/b8fb87f3fe2536ae95e46fc546229595fdf0241c) Thanks [@E1i](https://github.com/E1i)! - `construct init` now puts the tab-window hooks into the repository it materializes, tracked: it writes `scripts/construct/window-hooks.mjs`, the same script `attach` writes to `.construct/window-hooks.mjs`, and registers it in `.claude/settings.json` with a `Stop`, a `PreCompact` and a `SessionStart` (`compact`) entry. Into a `.claude/settings.json` that is already there, init appends the three entries after the repository's own and keeps every other key; a file it cannot read as hook settings is left alone and reported. The entries pass `--needs-construct`, so with no `construct` on the `PATH` each hook prints one line on stderr and does nothing.

- [#665](https://github.com/E1i/mikoshi-construct/pull/665) [`dcb82b7`](https://github.com/E1i/mikoshi-construct/commit/dcb82b749e3c9089b8a0e2c148f4eec6f1b21673) Thanks [@E1i](https://github.com/E1i)! - cli: in a repository that has `tests/harness-membership.test.ts`, `construct intake` adds it and `CONTRIBUTING.md` to the touches of a card that touches `package.json`, recording each as a correction that needs no confirmation; a repository without that test gets nothing added

- [#840](https://github.com/E1i/mikoshi-construct/pull/840) [`2a25a30`](https://github.com/E1i/mikoshi-construct/commit/2a25a30776176483c63bc0a6e10c9fdceee36c75) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake --admit` refuses, with exit `1` and nothing written, when a bus database exists on the machine (`~/.construct/bus.db`, or the file `CONSTRUCT_BUS_DB` names) and the run has no bus wired to write `card.admitted` into it; the refusal names `pnpm intake --admit`. Before, such a run wrote only the journal line, and a reader of the bus never saw the card admitted. On a machine with no bus database the command admits into the journal as before.

- [#791](https://github.com/E1i/mikoshi-construct/pull/791) [`f6525f3`](https://github.com/E1i/mikoshi-construct/commit/f6525f3667d76ffbf286b5d40a160417dedb862c) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake --admit` no longer says that `task:start` and the shift take the card it admitted. It prints what the run wrote: the card's `intake` line in the journal, and that no bus was wired, so no `card.admitted` was written. `task:start` and the shift are not part of the published CLI, so the old line promised something no generated project has. On a card it already admitted it says the same: no bus is wired, so nothing was written.

- [#883](https://github.com/E1i/mikoshi-construct/pull/883) [`4d1aec5`](https://github.com/E1i/mikoshi-construct/commit/4d1aec554a7e82b1217f1657ad2006a5f9caf011) Thanks [@E1i](https://github.com/E1i)! - `construct intake --admit` no longer admits a card whose `depends` name a card that is not merged: the card stays parked, a bus-wired run records a `card.waiting` naming those cards, and the exit is `3`. An amend of an admitted card is not affected.

- [#1066](https://github.com/E1i/mikoshi-construct/pull/1066) [`1b94f64`](https://github.com/E1i/mikoshi-construct/commit/1b94f64cacd8622f064aab4be0a67072ebab7500) Thanks [@E1i](https://github.com/E1i)! - Breaking: `construct mutate judge` drops its `--journal` flag, and `contract/surface.json` no longer records it; before 1.0 a removed flag is a minor bump, as `contract:bump` requires. A script that passed `--journal` is now refused as passing an unknown flag; drop the flag. `construct intake` and `construct mutate judge --card` no longer write `~/.construct/handoff/ghosts.jsonl`: intake records each card only through the bus a caller wires in, and `mutate judge --card` records its `mutation-judged` line in that bus and is refused when none is wired.

- [#819](https://github.com/E1i/mikoshi-construct/pull/819) [`3d050a4`](https://github.com/E1i/mikoshi-construct/commit/3d050a495b07e4ff339aa909a93c3d39be588456) Thanks [@E1i](https://github.com/E1i)! - cli: when a caller wires a bus into `construct intake`, a card admitted, amended or moved after `2026-10-12T17:04Z` is recorded only as `card.admitted` or `card.moved` in the bus, with no `intake` or `intake-move` line in the journal, and numbers, admissions and amendments read the bus for that time; without a bus, as in the published CLI, the journal lines are written as before

- [#1079](https://github.com/E1i/mikoshi-construct/pull/1079) [`0cc5a02`](https://github.com/E1i/mikoshi-construct/commit/0cc5a02bf80e59355f03e35c7e782f39fa67aaf9) Thanks [@E1i](https://github.com/E1i)! - Breaking: `construct intake` drops its `--journal` option and its `~/.construct/handoff/ghosts.jsonl` default. Closed and merged cards, numbers and recorded admissions are read from the bus the caller wires in alone; with no bus wired, a `#<id>` in `depends` or `blocks` is kept and marked unclear unless it is parked. `defaultWindowJournal` and `WINDOW_JOURNAL_FILE` are no longer exported.

- [#1098](https://github.com/E1i/mikoshi-construct/pull/1098) [`8179f03`](https://github.com/E1i/mikoshi-construct/commit/8179f0356d5409c0c138fe1c69e4b72d1cdc4bfd) Thanks [@E1i](https://github.com/E1i)! - New bin `construct-intake`: `construct intake` with every admit, slice and move recorded on your repository's bus, so the factory `construct-factory` started launches the card. Beside that bus `construct intake` no longer parks a card the factory cannot see: it writes nothing, names `construct-intake` and exits 1. From the installed package the factory's launch now cuts the card's tree and opens its pull request through the package's own built files, not through scripts of the mikoshi-construct checkout.

- [#877](https://github.com/E1i/mikoshi-construct/pull/877) [`f89b976`](https://github.com/E1i/mikoshi-construct/commit/f89b976e0ebd0ec761a289a5001f696c1a4dc48e) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake --move <card> --to <dir>` refuses, with exit `1` and nothing moved, when the run has no bus wired to write `card.moved`; the refusal names `pnpm intake --move`. Before, such a run moved the file and wrote only a journal line that no reader of the bus saw. A move to the directory the card already sits in no longer refuses as a taken number: it leaves the file where it is and records the move in the bus. When the bus write throws, the file goes back to where it was, a directory the move created is removed, and no journal line is left behind.

- [#984](https://github.com/E1i/mikoshi-construct/pull/984) [`a3c2150`](https://github.com/E1i/mikoshi-construct/commit/a3c215025a14ee107e780631a92757931f40165e) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake` adds a `seam: volume` line to a card whose touches hold more reading than one session context leaves room for (about 100000 tokens, counted from the size of every file the touches name). It proposes `slice: N volume` lines that each fit, keeping a generated file with its sources and a template with its twin, and holds the card for a person to confirm the slices or keep it whole.

- [#1061](https://github.com/E1i/mikoshi-construct/pull/1061) [`b81e14f`](https://github.com/E1i/mikoshi-construct/commit/b81e14fb1174b538809c2f171204bdaad8cb9097) Thanks [@E1i](https://github.com/E1i)! - cli: when a caller wires a bus into `construct intake`, intake writes no parking file: a sliced card's text travels in its `card.admitted` alone, `--admit` leaves a person's file as it was written, and `--move` of a card with no file moves it in the bus. The published CLI, which has no bus, parks cards as before.

- [#955](https://github.com/E1i/mikoshi-construct/pull/955) [`1d63ab7`](https://github.com/E1i/mikoshi-construct/commit/1d63ab745000fe1b0cb4a56c39b2a98ca0de732a) Thanks [@E1i](https://github.com/E1i)! - cli: a card's milestone is no longer checked against a list built into the tool. `parseCard` takes the project's milestone list as an argument and refuses a milestone outside it. With no list, it accepts any slug of a-z, 0-9 and '-', or '—', so a card written in another repository parses. A project lists its milestones as the `milestones` array of its construct.json, and `construct intake --admit` and `task:start` hold a card to that list; this repository's own list now lives there.

- [#1040](https://github.com/E1i/mikoshi-construct/pull/1040) [`bbd3245`](https://github.com/E1i/mikoshi-construct/commit/bbd32453cb962d62d669668b5b85126ab5ca5422) Thanks [@E1i](https://github.com/E1i)! - cli: the waits in `construct board` come only from the owner waits the bus records, each shown with its id, what it needs (a decision, a merge or a command), its text and the command to run; the board no longer guesses a wait from a stopped card's question, an authority denial or an open version pull request

- [#1042](https://github.com/E1i/mikoshi-construct/pull/1042) [`b2eedc5`](https://github.com/E1i/mikoshi-construct/commit/b2eedc56448228c5f78ef9fbd8c3851305a593ec) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake --admit` no longer admits an amend that deletes an admitted witness or drops "red on main" from one; it leaves the admitted body standing, exits 3, names the decision the owner records to allow each downgrade, and with the bus wired writes a `card.waiting` the bus turns into an owner wait. Once the owner's decision scoped to the card names the downgrade, the amend is admitted. Adding or tightening a witness, and a card with no admitted body, are admitted as before

- [#699](https://github.com/E1i/mikoshi-construct/pull/699) [`d253c30`](https://github.com/E1i/mikoshi-construct/commit/d253c30f55a2a671f34ed1319111c800f8838d8f) Thanks [@E1i](https://github.com/E1i)! - cli: when `construct intake` proposes a risk seam, a test now goes into the slice of the higher-risk code it checks. This covers tests under `tests/` and tests under `scripts/tests/<area>/`, which match only code under `scripts/`. A test matches when its file name or one of its directories under the test root matches a path segment of that code. The test name may also be that segment followed by `-` and more. The top-level directory of the code path and `commands` never count as a match. Before this, every test went into the lower slice, where it could not fail on the code it checks. Intake also refuses a card whose task text has its own `slice:` lines when a seam proposes different slices, unless a person kept the card whole. The reason it gives names both ways to settle it

### Patch Changes

- [#683](https://github.com/E1i/mikoshi-construct/pull/683) [`41f8d96`](https://github.com/E1i/mikoshi-construct/commit/41f8d9609f1e55bc7663c1e5e215b87c4625095f) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake --admit` refuses a card whose witness passes a `-t` that is not a valid regex, naming the witness and the compile error as `--draft` already does, so a card parked earlier or edited by hand can no longer be admitted with a witness that never exits 0

- [#904](https://github.com/E1i/mikoshi-construct/pull/904) [`6c368b8`](https://github.com/E1i/mikoshi-construct/commit/6c368b84e3ffa293f205e2af65d31c0e1ec14a3e) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake --admit` now holds a card it corrects, including one whose merged `depends` it drops, behind a confirmation token and exit 2 until `--confirm <token>` or `--auto-confirm` is given; only an added script companion passes without one, and a person's confirmation is recorded only when `--confirm` was given

- [#693](https://github.com/E1i/mikoshi-construct/pull/693) [`7021a38`](https://github.com/E1i/mikoshi-construct/commit/7021a387ba5975cedcf52793c5ae332d2812733a) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake --admit` resolves a card's depends and blocks against every lane under the parking root, not only the card's own directory, so a card that depends on one parked in another lane is no longer marked unclear

- [#1054](https://github.com/E1i/mikoshi-construct/pull/1054) [`33a7bb5`](https://github.com/E1i/mikoshi-construct/commit/33a7bb5754350168defcd1fbbc533713885128d4) Thanks [@E1i](https://github.com/E1i)! - cli: the board's bus reader lists the queued and leased tasks of the bus and the latest events of each card, which `pnpm board --json` prints beside each card's stage; with the bus database unreadable, `pnpm board` prints `the bus stopped at <ts>: <error>`, the open owner waits from the last board snapshot and the handoff, and the snapshot's age, red when older than two ticks

- [#1023](https://github.com/E1i/mikoshi-construct/pull/1023) [`7b963f9`](https://github.com/E1i/mikoshi-construct/commit/7b963f9eb3b04613ef90371fff1ca94f7dfbc5ba) Thanks [@E1i](https://github.com/E1i)! - cli: `construct board` gives each card its stage (planned, in work, review, answer/changes, ready, merged, stopped, dropped) from its open task in the bus queues, else from its state, and the Backlog prints that stage; the goal line reads `merged N/M` followed by the count of the goal's cards in each open stage; a `waits for you` line under it lists an open owner question, an owner-only merge denial on an open pull request and an open pull request that no card owns, and is absent when nothing waits; Services shows a session only while it is live — its card is not merged or closed, its step is the card's current stage, and its last pulse is at most 10 minutes old

- [#1016](https://github.com/E1i/mikoshi-construct/pull/1016) [`7daba99`](https://github.com/E1i/mikoshi-construct/commit/7daba993851b1b9d492db9839018e659973de6a8) Thanks [@E1i](https://github.com/E1i)! - cli: `construct board` names the bus's last failure of any kind in its footer: a card that fell, a card that lost its session, or a `card.stopped` with reason `fault`, which reads `card #N stopped on a fault at <ts>`; before, a fault stop was skipped and the footer could name an older failure

- [#1074](https://github.com/E1i/mikoshi-construct/pull/1074) [`a5ff444`](https://github.com/E1i/mikoshi-construct/commit/a5ff4445a74b6e89bc553b6d3c7dab8144a6172a) Thanks [@E1i](https://github.com/E1i)! - cli: `construct board` reads one stage per card: a stopped card whose answer, review or merge task is leased shows at that task's stage and counts as live, and the Flow columns sort cards by stage, so a card in answer after a stop is no longer missing from Flow, and a card's task and its session of the same role and task show as one service tile, not two

- [#977](https://github.com/E1i/mikoshi-construct/pull/977) [`c371715`](https://github.com/E1i/mikoshi-construct/commit/c3717154b48fbc7a01cb9930c8f1abe624d27463) Thanks [@E1i](https://github.com/E1i)! - cli: `construct board` builds its three screens from one model that the factory's board page now renders too, so both show the same lines; the command's output is unchanged

- [#1035](https://github.com/E1i/mikoshi-construct/pull/1035) [`a501e0a`](https://github.com/E1i/mikoshi-construct/commit/a501e0a5e44edd0db56f186119dc138541a3fc7b) Thanks [@E1i](https://github.com/E1i)! - `construct board` reads each queue's capacity from its bus node's latest `process.heartbeat` and shows slots as `<queue> used/total`, for example `answer 0/5`; the "(the bus records no capacity)" note is gone. A queue whose node has written no heartbeat shows only the slots in use, with no denominator.

- [#873](https://github.com/E1i/mikoshi-construct/pull/873) [`ca84dc0`](https://github.com/E1i/mikoshi-construct/commit/ca84dc0bedca87116d55ad4de9612773cb900f97) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake` reads a touch of `scripts/bus/queue.ts` as risk R1, the factory mechanism that decides on merging, so a card that changes it gets decision `owner` and the bus never merges it on its own; the rest of `scripts/bus/` stays R4

- [#823](https://github.com/E1i/mikoshi-construct/pull/823) [`e317e82`](https://github.com/E1i/mikoshi-construct/commit/e317e820e004cebe0ffdfce375719a6f1dc50d35) Thanks [@E1i](https://github.com/E1i)! - When a caller wires a card-event port into `construct intake`, each `card.admitted` event it hands over now also carries the admitted card's whole `text` and its sha256 as `textSha`. Without a port, which is how the published CLI runs, `construct intake` writes the same parking files and journal lines as before.

- [#1099](https://github.com/E1i/mikoshi-construct/pull/1099) [`26b57c0`](https://github.com/E1i/mikoshi-construct/commit/26b57c0ef76671a31ac0bdf8369e96836ab31d9c) Thanks [@E1i](https://github.com/E1i)! - factory: a card session the factory starts no longer inherits `CONSTRUCT_BUS_DB`, so a session working in another repository cannot write into the bus that launched it; the step after the session that opens its pull request still runs on the launching bus. Inside a repository, a `CONSTRUCT_BUS_DB` that names a bus under `~/.construct` belonging to another repository — neither this repository's own bus nor the machine bus `~/.construct/bus.db` — is refused, and the built bus intake exits `1` with the reason and writes nothing. A path outside `~/.construct`, and the bus the supervisor pins for a worker started outside any repository, are still taken as named.

- [#754](https://github.com/E1i/mikoshi-construct/pull/754) [`2dac2c3`](https://github.com/E1i/mikoshi-construct/commit/2dac2c31178e59af9ee536a0b4f112540efa8958) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake` and `construct intake --admit` add a changeset to a card's touches only for a path the package publishes, read from the `files` field of the repository's `package.json` — a `templates/` path directly and a `src/` path when `dist` is published — so a touch under `scripts/` gets none, and a repository with no `files` field gets no changeset companion

- [#684](https://github.com/E1i/mikoshi-construct/pull/684) [`b9d84b6`](https://github.com/E1i/mikoshi-construct/commit/b9d84b67aae25dc6957820a2d996c0e7f318da5a) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake` adds what every change of a kind carries to a card's touches as a correction — the README, `docs/cli.md` and a `docs/guide` page for a change to the command definitions, a changeset for published code, and the test beside a source module — each row only in a repository that keeps the file that holds it

- [#813](https://github.com/E1i/mikoshi-construct/pull/813) [`30453a2`](https://github.com/E1i/mikoshi-construct/commit/30453a20583da2f066bfab0a812610bbebd5eba8) Thanks [@E1i](https://github.com/E1i)! - `construct cost` names a cheap task closed in the window journal at or after `2026-10-12T17:04Z` in its class's note even when the journal holds no start line for it, taking the class from the task's intake line; such a task was left out silently before.

- [#697](https://github.com/E1i/mikoshi-construct/pull/697) [`28f61df`](https://github.com/E1i/mikoshi-construct/commit/28f61dfcccf5a3638fb43e480fc8a34baf9877d4) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake` reads a `creates` entry written as `<path> (ghosts)` or `<path> (plain)` as the path it creates, the same way the shift guard does, and refuses any other form (`--admit` marks it `unclear: creates`) instead of treating the whole entry as a path that does not exist

- [#812](https://github.com/E1i/mikoshi-construct/pull/812) [`4d1641c`](https://github.com/E1i/mikoshi-construct/commit/4d1641c7c81b9a225df94a612d6fdd3d4f0aec51) Thanks [@E1i](https://github.com/E1i)! - Without a connected bus — the published CLI wires none — `construct intake` counts every journal line whatever its time, so a merge line written after `2026-10-12T17:04Z` removes a `depends` or `blocks` again; the cutoff applies only when a caller wires a bus in.

- [#1100](https://github.com/E1i/mikoshi-construct/pull/1100) [`14f3320`](https://github.com/E1i/mikoshi-construct/commit/14f3320f073240581fc4d2b4036a429b77e82ca8) Thanks [@E1i](https://github.com/E1i)! - factory: a cheap card whose diff MORSE predicts for the ladder no longer returns to its session for a `Path (D-76):` line; the pull request opens and its path line reads `cheap holds as the default path of D-224`. A reason the card or the session report names still comes first. The review session now reads the pull request description, as GitHub holds it when the review starts, between `<pull-request>` markers beside the card, and a full review no longer makes a missing D-76 reason a finding.

- [#1031](https://github.com/E1i/mikoshi-construct/pull/1031) [`6c6a991`](https://github.com/E1i/mikoshi-construct/commit/6c6a991fbe1fbff22b9c5cdf3da02c85e3c1a0a6) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake` adds `scripts/tests/core/events.test.ts` to the touches of a card that touches a file under `scripts/` or `src/`, because that test reads every source file in both trees.

- [#1095](https://github.com/E1i/mikoshi-construct/pull/1095) [`265ef4d`](https://github.com/E1i/mikoshi-construct/commit/265ef4d287507a7ec2c932cefc66696693d980cf) Thanks [@E1i](https://github.com/E1i)! - `construct board`: the board reads the bus of the repository `--dir` names, at `~/.construct/<owner>--<repo>/bus.db`, where `<owner>/<repo>` comes from that repository's git remote (`origin` first; a repository without a remote gets a local id of its own). A foreign repository no longer shows another repository's lanes and cards. A machine-wide `~/.construct/bus.db` from before is still read until the repository has a bus of its own; `CONSTRUCT_BUS_DB` still names a bus outright. The bus that serves a repository keeps its database, logs and switch file in that same `~/.construct/<owner>--<repo>/`. The launchd job `scripts/bus/launchd/dev.mikoshi.bus.plist` no longer starts in a fixed checkout and no longer passes a `GH_TOKEN` for a fixed account: gh answers with its active account, and the job runs in the checkout `CONSTRUCT_FACTORY_DIR` names. Set it once with `launchctl setenv CONSTRUCT_FACTORY_DIR <checkout>` before reloading the job; without it the job exits 1 and `~/.construct/dev.mikoshi.bus.log` names the missing variable.

- [#913](https://github.com/E1i/mikoshi-construct/pull/913) [`21afabc`](https://github.com/E1i/mikoshi-construct/commit/21afabcd2f9efa5c8e7bb8c2c5f145c8cd2283d9) Thanks [@E1i](https://github.com/E1i)! - The generated `/implement` skill instructs the session to wait in the same turn after launching the ladder's Workflow, instead of ending the turn.

- [#757](https://github.com/E1i/mikoshi-construct/pull/757) [`95a076e`](https://github.com/E1i/mikoshi-construct/commit/95a076e3dfddbaa18b3d4a448f28ae33a5e69fe4) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake --draft` and `--admit` make a card `owner` when any of its touches reads risk R1, whatever `architecture/owner-merges.md` lists; the `.changeset/**` companion intake adds reads no R1 and `.changeset/config.json` does, so the card's risk line and its decision read the same risk; they never lower a card's `owner` decision to `auto`; `--admit` no longer refuses a hand-written `owner` on a card that touches no owner path

- [#1032](https://github.com/E1i/mikoshi-construct/pull/1032) [`43398de`](https://github.com/E1i/mikoshi-construct/commit/43398de7900fea1dd10f81e1f7cfa6df01827555) Thanks [@E1i](https://github.com/E1i)! - `construct intake` and `construct intake --admit` now run `bash -n -c` on every witness command and mark a witness unclear when the shell rejects it, naming the witness and the shell's message. The spawn lives in one module, `src/commands/intake/bash-syntax.ts`, the only file of intake the lint policy lets import `node:child_process`.

- [#1024](https://github.com/E1i/mikoshi-construct/pull/1024) [`a5c4b7f`](https://github.com/E1i/mikoshi-construct/commit/a5c4b7fe0162bce7ac78278ac3fe6809348389fc) Thanks [@E1i](https://github.com/E1i)! - `construct intake` now marks a witness unclear when one of its commands names `origin/main`, which moves while a run is in progress. The check now lives in the intake check, and the ghosts preflight imports it from there.

- [#1094](https://github.com/E1i/mikoshi-construct/pull/1094) [`3aa1cb2`](https://github.com/E1i/mikoshi-construct/commit/3aa1cb2e30ca6a0f9cfcd4862189958614e4388d) Thanks [@E1i](https://github.com/E1i)! - The `intake` skill that `init` and `attach` write into `.claude/skills/intake/SKILL.md` no longer names the removed `--journal` option or its `~/.construct/handoff/ghosts.jsonl` default: it says `construct intake` checks cards against the closed and merged cards the bus records, and records each parked card in the bus as one `card.admitted`.

- [#775](https://github.com/E1i/mikoshi-construct/pull/775) [`c945284`](https://github.com/E1i/mikoshi-construct/commit/c945284253ef2ecd5b996fa566183480a690a953) Thanks [@E1i](https://github.com/E1i)! - internal: `construct intake --admit` and `--move` can hand `card.admitted` and `card.moved` to an event port that a caller inside the repository supplies, after the journal line they write as before. The published CLI supplies none, so its behaviour is unchanged

- [#1051](https://github.com/E1i/mikoshi-construct/pull/1051) [`e47dbbf`](https://github.com/E1i/mikoshi-construct/commit/e47dbbfae3f8ff22083e1bbad83ae4278eeb3c29) Thanks [@E1i](https://github.com/E1i)! - cli: `construct board` groups the backlog by the lane the bus last assigned each live card (`lane.assigned`), not by the parking folder its admission named, and shows every one of the bus's N chain lanes, the empty ones included; a merged, closed or dropped card shows no lane and is found through the merged and closed filters.

- [#807](https://github.com/E1i/mikoshi-construct/pull/807) [`b807ab3`](https://github.com/E1i/mikoshi-construct/commit/b807ab38494b9a5bff9bb7d4940adaa75576b9bc) Thanks [@E1i](https://github.com/E1i)! - `src/card/closed.ts` exports `writtenBeforeHistoryEnds`, the predicate that decides whether a journal line was written before `2026-10-12T17:04Z`, unchanged.

- [#1102](https://github.com/E1i/mikoshi-construct/pull/1102) [`9878514`](https://github.com/E1i/mikoshi-construct/commit/9878514bb0cd68babebb613017f058779bbc0040) Thanks [@E1i](https://github.com/E1i)! - factory: the bus no longer merges a card's pull request while an owner question of that card is open. The merge is denied with the reason `owner_question_open`, the detail names each open question by its id and text, and the merge task goes back to the queue without counting as a failure; it merges once the question is answered. A pull request GitHub already merged at the leased head is still recorded.

- [#1105](https://github.com/E1i/mikoshi-construct/pull/1105) [`b30d784`](https://github.com/E1i/mikoshi-construct/commit/b30d784f728997079215d2f98bf353ab84b536ee) Thanks [@E1i](https://github.com/E1i)! - factory: the owner board no longer loses or refuses what it should show. A card's merge leaves its open decision questions open; they still close when the card is closed or dropped. `bus:request owner.wait.close` now closes a `W` wait as well as a `Q` one. An owner wait to check the proof mechanism, which names a pull request and no command, is opened instead of rejected. A session the launch node stops by fault raises a `board.alarm` naming its launch task, so a window requeue of that task is accepted, and a requeue the bus rejects is answered as refused, not done.

- [#706](https://github.com/E1i/mikoshi-construct/pull/706) [`7f607e6`](https://github.com/E1i/mikoshi-construct/commit/7f607e66269c29dda044b38df5ab69f1507f2da2) Thanks [@E1i](https://github.com/E1i)! - cli: no change in behaviour — `construct intake` and `construct intake --admit` now walk the parking lanes through one shared reader instead of two copies of it

- [#696](https://github.com/E1i/mikoshi-construct/pull/696) [`410ba6e`](https://github.com/E1i/mikoshi-construct/commit/410ba6edf494c7e3dee45acc57548a6d76cb00df) Thanks [@E1i](https://github.com/E1i)! - card: `readBodyCard` in `src/card/grammar.ts` is the one reader of a pull request body's card line, accepting the line with or without a leading `card: `; `shift:merge` (merge, verdict and `--carry`), `task:merged` and `task:close` read the body through it, so a body opening with `card: #N …` is no longer refused as "not a card". The line is still written in one form, `cardLine`, without the prefix

- [#937](https://github.com/E1i/mikoshi-construct/pull/937) [`821fb83`](https://github.com/E1i/mikoshi-construct/commit/821fb834b1768888be1d264c83efd9c88c82954c) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake` puts a test file in the risk slice of the code it is named for, and no longer in the slice of any code that shares one of its directory names. Before, every test under `scripts/tests/bus/` followed `scripts/bus/queue.ts` to the R1 slice. The bus files that decide on closing, merging and admitting a task now read R1 like `scripts/bus/queue.ts`: `admissions.ts`, `close-executor.ts`, `merge-executor.ts`, `round-limit-decision.ts` and `update-done.ts`. They read R4 before.

- [#1003](https://github.com/E1i/mikoshi-construct/pull/1003) [`3df6db5`](https://github.com/E1i/mikoshi-construct/commit/3df6db594613cf30c1ea96aad31452c50b64253f) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake`, `construct board` and `construct cost` read the bus event names and the bus database path from one shared module instead of each holding its own copy; every event string and the default bus path stay byte-identical, so nothing a command prints, writes or reads changes

- [#1053](https://github.com/E1i/mikoshi-construct/pull/1053) [`8a34374`](https://github.com/E1i/mikoshi-construct/commit/8a34374aa16137e8c9eaed8bd91ca5634450eaef) Thanks [@E1i](https://github.com/E1i)! - cli: the `card.moved` or `card.dropped` event `intake --move` writes into the bus carries a dedupe key that names the target lane, not its absolute directory, so the same log replayed in a copy of the repository at another path yields the same keys.

- [#1011](https://github.com/E1i/mikoshi-construct/pull/1011) [`bb70a92`](https://github.com/E1i/mikoshi-construct/commit/bb70a925bd99d06ded25681044c8dab0afbf42dc) Thanks [@E1i](https://github.com/E1i)! - `construct intake --admit` now derives a card's decision from the paths it touches and the paths it creates: a new R1 file listed under `creates:` makes the decision owner.

- [#1086](https://github.com/E1i/mikoshi-construct/pull/1086) [`2420840`](https://github.com/E1i/mikoshi-construct/commit/242084059653aea3a10af5d617c632de2b2b025f) Thanks [@E1i](https://github.com/E1i)! - `construct intake` names `scripts/tests/bus/journal-guard.test.ts` on the Runs line of a card that touches `src/` or `scripts/`, since that test walks both trees.

- [#965](https://github.com/E1i/mikoshi-construct/pull/965) [`5cd8cbd`](https://github.com/E1i/mikoshi-construct/commit/5cd8cbd71c07062fa9e84f1cf30f559aa99236bb) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake` adds to a card's touches every test that imports a touched file, directly or through other modules, and for `package.json` the tests that read its scripts, without asking a person to confirm. A directory with more than six such tests is added as one `<dir>/**`. These tests do not count toward the "more than 6 touches" signal that proposes cutting a card into slices.

- [#973](https://github.com/E1i/mikoshi-construct/pull/973) [`ba9f321`](https://github.com/E1i/mikoshi-construct/commit/ba9f321ccd2580c86a66ce8af8cf42d668589ecc) Thanks [@E1i](https://github.com/E1i)! - cli: `construct intake` no longer adds the tests that cover a card's touched files to its touches. It writes them on a `Runs:` line of the card body instead: the tests the card runs, which it may also change. Two cards that share only runs are no longer counted as overlapping. A test the card must carry as a companion, such as `tests/harness-membership.test.ts` for `package.json`, stays in touches.

- [#1045](https://github.com/E1i/mikoshi-construct/pull/1045) [`8140ac4`](https://github.com/E1i/mikoshi-construct/commit/8140ac40e9c593fb1633d4ec95e9b2033af24d65) Thanks [@E1i](https://github.com/E1i)! - `construct intake` and `construct intake --admit` now refuse a card whose touches put a `/**` mask over a directory of the factory's shared code (`scripts/bus`, `scripts/core`, `src/commands/board` and the rest of one explicit list). Masks over `tests/**`, `scripts/tests/**`, `.changeset/**` and a new directory named in `creates` are still accepted. The refusal names the mask and, when the contour map lists files under that directory, proposes them in its place.

- [#1104](https://github.com/E1i/mikoshi-construct/pull/1104) [`203c75d`](https://github.com/E1i/mikoshi-construct/commit/203c75de1f97c1dff071a1108c8c3cf89609d785) Thanks [@E1i](https://github.com/E1i)! - factory: the witness node and the merge gate read a card's body sha and its witnesses from one admission, the latest `card.admitted` that carries the card text, so a witness record taken while a card amend has not yet reached the bus's card-body projection no longer pairs the new body's sha with the previous body's witnesses.

- [#1103](https://github.com/E1i/mikoshi-construct/pull/1103) [`ebb0f12`](https://github.com/E1i/mikoshi-construct/commit/ebb0f12e60ee670a09b32d241461b9f36a8be3dc) Thanks [@E1i](https://github.com/E1i)! - intake: a witness that cannot run is marked unclear before launch, at intake and at `--admit` alike, with the witness and the reason named. Three new reasons sit beside the unresolved command, `origin/main` and `bash -n` ones: a witness written as prose (a `→` step chain, output "in the PR body", a step done by hand), a witness whose command names a path outside the worktree it runs in (`~/…`, `$HOME`, or any absolute path, the checkout intake reads included; `/dev/`, a `-t` test-name pattern and an output redirect target are not read paths), and a witness that reads nothing the tree under test can change (no repository path, and no `pnpm`, `node`, `git` or similar tool beyond `--version` or `--help`), so its result cannot depend on the head.

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

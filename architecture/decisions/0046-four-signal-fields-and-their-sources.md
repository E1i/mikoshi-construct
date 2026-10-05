# 0046 — Four signal fields, each read from a machine source

Status: accepted · 2026-10-03

## Context

The points where a task is started, launched or read back (`pnpm task:start`, `pnpm shift`, `pnpm shift:report`,
`pnpm ghosts:launch`, `pnpm board`, `construct board`) each printed their own line or table. A reader had to learn
each shape, and nothing said which part of a line was the agreement, the forecast, what ran, or what came of it.
A forecast printed at launch could not be laid beside what the task spent, because no two points named the same
things in the same place.

## Decision

1. **Four fields, in this order**: `CONTRACT`, `EXPECT`, `ACTION`, `RESULT`. `SIGNAL_FIELDS` in `src/ui/signal.ts`
   is the list, and `renderSignal` the only renderer of the block: a title rule, then one line per field,
   `<LABEL> | <value>`.
2. **Every value comes from a machine source**, never typed by the reader:

   | Point | CONTRACT | EXPECT | ACTION | RESULT |
   |-------|----------|--------|--------|--------|
   | `task:start` (entry) | the `--card` | not recorded: the session is the window's, shared by every task in the window, so none is this task's alone | the branch and the tree it cuts, and the start line it wrote | `accepted · not started` |
   | `task:close` (exit) | the entry line's `CONTRACT`, byte for byte, or `contract not recorded in <journal>` | the entry line's `EXPECT`, byte for byte, or `expect not recorded in <journal>` | the closing call: outcome, its value and the verification word | `closed <verification> · <PR or report> · line written to <journal>` |
   | `shift` (start of a task) | the task file's card and `touches:` | `formatCheapExpect`: the median tokens (input, cache writes and output; cache reads left out, the unit of the ladder's `expect:`) and minutes of the finished cheap tasks of its kind and size in the shift journals and the window journal, or none with n and the class below five | the branch and the session it starts | the outcome line that follows |
   | `shift:report` | the entry line's `CONTRACT` in `ghosts.jsonl`, or `contract not recorded in <journal>` | the entry line's `EXPECT` in `ghosts.jsonl`, or `expect not recorded in <journal>` | the session, branch and duration in `shift.jsonl` | exit, the PR from `gh`, whether `task:close` closed it (`closed <verification>` or `not closed`), the Eddies stop, the report's `result:` |
   | `ghosts:launch` (entry) | the brief and its approved sha; the law is the brief's `Acceptance:` line | `formatExpect` of the brief's `expect:` | the `/implement` call, tree, sketch, report and session | `accepted · not started`; the outcome line follows the yes |
   | `/implement` step 0 (entry) and step 5 (exit) | the first line of the agreed text, its `Effort:`, the count of its `Acceptance:` items and of its `Immutable:` paths | the agreed text's `expect:` line, or `expect not recorded in the brief` | step 0: `/implement agreed <sha7>`; step 5: the run, its attempts and the passing rung | step 0: `accepted · not started`; step 5: the `status` written to `.construct/runs.jsonl` |
   | `pnpm board` (card) | cheap path: the entry line's `CONTRACT` in `ghosts.jsonl`, or `contract not recorded in <journal>`; ladder: the brief, `law not recorded in the journal` | cheap path: the entry line's `EXPECT` in `ghosts.jsonl`, or `expect not recorded in <journal>`; ladder: `formatExpect` of `event:task` `expected` | the start line or `event:task` | the latest stage |
   | `construct board` | — | `EXPECT` column | — | `ACTUAL` column: the ledger's tokens and seconds |
   | `construct cost` (one block per class) | the class and the shift root | the cheap forecast of the class, in the unit of the shift's `EXPECT`, or none with n below five; with no finished cheap task, `finished cheap tasks not recorded in <shift root>` | the tasks of the class read, and how many have every session readable | whether there is a forecast |

   `construct board` prints only the `EXPECT` and `ACTUAL` columns, with no block per row and no view of its own.
   `--json` is unchanged.
3. **A value that no source holds says so, in one form everywhere**: `<what> not recorded <where>`, naming the
   place that holds no record — `law not recorded in the journal`, `touches not recorded in shift.jsonl`,
   `expect not recorded on the card`, `expect not recorded in .construct/runs.jsonl`. A field is never empty and
   never guessed. `—` stays only where a value does not apply, such as `EXPECT` on a pull request row.
4. **The visual contract**: no emoji and no pictograms; uppercase labels; ASCII-safe, so that without colour the
   rule is `-` and the separator `|`, and a value passes through byte for byte. Only `RESULT` is coloured, by its
   tone. `NO_COLOR` or a stream that is not a TTY drops the colour and loses no information.
   ASCII-safe binds the frame only: a value from `formatExpect` keeps its `≈` and `—` as they are.
5. **The report form follows the same order.** A window report, a shift report and a probe report open with the
   card, then `contract:`, `expect:`, `action:`, `result:`, one line each. The labels stay lowercase in a file so
   that the `result:` line every reader already parses keeps its form.

6. **The law of the entry card: work starts with a card and ends with the same card.** Before the first token is
   spent, the start point prints its card, with `RESULT` = `accepted · not started`; at the end the exit prints the
   same four fields with `RESULT` the fact. `CONTRACT` and `EXPECT` of the exit are the entry's, byte for byte, read
   from the entry and never derived again from a source that may have moved. The entry card is written to
   `ghosts.jsonl` beside the start as one line `{"event":"entry","task","CONTRACT","EXPECT","ACTION","RESULT","ts"}`,
   written in the same append as the `task:start` line and by `ghosts:launch` after the yes, before any session; no
   reader of the journal acts on an event it does not name, so the line is invisible to them.
7. **One renderer holds in a generated repository too.** A generated repository has no `src/ui/signal.ts`; its
   `scripts/construct/check-acceptance.mjs card` prints the block in `renderSignal`'s plain form, and
   `tests/check-acceptance-card.test.ts` asserts byte equality with `renderSignal(…, PLAIN_STYLE)` for the same
   signal, so a change to the renderer fails there. The script does not import the renderer: it ships alone.

## Values the journal does not hold

These points cannot fill a field from a record today, so the field says what is missing. Whether the storage
should carry them is #138; this decision does not extend any record.

- `task:start`, the start of a shift task and `shift:report`: no forecast and no law; `shift.jsonl` holds no touches.
- `task:close` of a task started before the entry line existed: no entry line, so `CONTRACT` and `EXPECT` say so.
- `ghosts:launch`: `expected` reaches the journal only after the session ends, in `event:task`; the law is only in
  the brief's text.
- `construct board`: `.construct/runs.jsonl` records no forecast.
- `pnpm board`: the law is not in the journal, and a cheap-path start line carries no touches.

## Consequences

- One shape across seven points: a reader finds the forecast and the outcome at the same place everywhere, and
  `formatExpect`'s text is the same string at launch and on the board.
- `shift:report` prints one block per task instead of a table; a script that read the table's columns reads the
  `RESULT` line instead.
- A gap in the records is visible on every run, as words in a field, until #138 decides it.

## Enforced by

- L3 tests under `pnpm run quality`: `tests/ui/signal.test.ts` (order, labels, ASCII and colour), and per point
  `scripts/tests/ghosts/task-start.test.ts` (w8), `scripts/tests/shift/shift.e2e.test.ts` (w3, w6, w7, w8),
  `scripts/tests/ghosts/launch.e2e.test.ts` through `world.sh check-decision`, `scripts/tests/board/board.test.ts`
  (w9), `tests/board.test.ts` and `tests/cost-cheap.test.ts`; for the entry card, `tests/check-acceptance-card.test.ts` (the four fields, `not recorded`, byte equality with `renderSignal`, the exit repeating the entry),
  `scripts/tests/ghosts/entry.test.ts`, `task-start.test.ts` (w8), `task-start-entry.test.ts` (the entry line written
  beside the start line, carrying what was printed), `launch-entry.e2e.test.ts` (one entry line per card `ghosts:launch`
  prints, before its task line, byte equal to the printed CONTRACT, EXPECT and ACTION), `task-close.test.ts` (the exit
  card repeating the task's entry line, `not recorded` when there is none), `entry-readers.test.ts` (the journal's
  readers read past an entry line) and `world.sh check-journal`.
- The template and its twin in `.claude/` are held by `tests/attach-carriers.test.ts`.
- L1 review for the report form in a file, which no test reads.

## What would reverse it

A reader who acts on a field and finds its source said something else, or a point whose four fields cannot be told
apart from one another in practice. Then the field list or a source changes here first.

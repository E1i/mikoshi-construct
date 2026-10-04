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
   | `task:start` | the `--card` | not recorded: the session is the window's, shared by every task in the window, so none is this task's alone | the branch and the tree it cuts | the start line it wrote |
   | `shift` (start of a task) | the task file's card and `touches:` | `formatCheapExpect`: the median tokens (input, cache writes and output; cache reads left out, the unit of the ladder's `expect:`) and minutes of the finished cheap tasks of its kind and size in the shift journals and the window journal, or none with n and the class below five | the branch and the session it starts | the outcome line that follows |
   | `shift:report` | the card in `shift.jsonl` | not recorded | the session, branch and duration in `shift.jsonl` | exit, the PR from `gh`, whether `task:close` closed it (`closed <verification>` or `not closed`), the Eddies stop, the report's `result:` |
   | `ghosts:launch` | the brief and its approved sha; the law is the brief's `Acceptance:` line | `formatExpect` of the brief's `expect:` | the `/implement` call, tree, sketch, report and session | not launched yet; the outcome line follows the yes |
   | `pnpm board` (card) | the card on the start line | `formatExpect` of `event:task` `expected` | the start line or `event:task` | the latest stage |
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

## Values the journal does not hold

These points cannot fill a field from a record today, so the field says what is missing. Whether the storage
should carry them is #138; this decision does not extend any record.

- `task:start`, the start of a shift task and `shift:report`: no forecast and no law; `shift.jsonl` holds no touches.
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
  (w9), `tests/board.test.ts` and `tests/cost-cheap.test.ts`.
- L1 review for the report form in a file, which no test reads.

## What would reverse it

A reader who acts on a field and finds its source said something else, or a point whose four fields cannot be told
apart from one another in practice. Then the field list or a source changes here first.

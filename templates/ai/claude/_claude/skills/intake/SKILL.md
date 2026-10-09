---
name: intake
description: Slice a person's free retelling of work into parking cards — one card per change, every field the retelling does not settle marked unclear, numbers assigned by construct intake, never by memory.
user-invocable: true
argument-hint: <the retelling, as the person said it>
---

Slice the retelling in `$ARGUMENTS` into parking cards. You decide what the retelling means; `construct intake`
numbers the cards, writes them in the parking format and checks each one with the same grammar `task:start` and
the shift read. There is no second format: never write a parking file by hand.

## 1. Slice

One card per change that merges on its own: one task, one branch, one pull request. Keep the person's order; a
card that needs another one first names it in `depends`. For each card settle:

- `name` — a slug of a-z, 0-9 and `-`.
- `kind` — `implement` (a change, in main once the journal holds the merge line of its pull request) or `probe`
  (knowledge, closed by its report).
- `milestone` — one of the closed list the card grammar holds; a refusal from `construct intake` prints it.
- `size` — `XS`, `S`, `M` or `L`.
- `contour` — `cheap` or `ladder`; `decision` — `owner` or `auto` for implement, `none` for probe.
- `touches` — the paths the change may edit, repository-relative, `*` only as a trailing `/**`.
- `depends` / `blocks` — another card of this draft by its `name`, or an existing card as `#<id>`.
- `who` — `shift` for a card the unattended shift may take, otherwise `window`.
- `task` — what to do, in the person's words where they are precise.
- `witnesses` — how the result is shown to hold: a test, a command and its exit, a report line.

## 2. Mark what is unclear, never guess it silently

A field the retelling does not settle goes into the card's `unclear` list as `{ "field", "reason" }`, with the
value you chose and why in the reason:

- `contour` and `decision`: leave them out. `construct intake` sets `ladder` and `owner` and marks each.
- `name`, `kind`, `milestone`, `size`, `touches`, `task`, `witnesses` have no default. Ask the person for any of
  them the retelling does not give; `construct intake` refuses a card that lacks one.
- In a repository reached through `construct attach`, the milestone list is not that repository's own: give an
  explicit milestone from the list and mark `milestone` unclear.
- A number the person names for a card is not used: `construct intake` assigns every number.

A card with any unclear field is written with `who: window`, so the shift does not take it until a person settles it.

## 3. Write the draft and run intake

Write the draft outside the repository, for example `~/.construct/intake/<date>-<slug>.json`:

```json
{ "cards": [ { "name": "…", "kind": "implement", "milestone": "…", "size": "S", "touches": ["src/…/**"],
  "depends": [], "who": "shift", "task": "…", "witnesses": ["…"], "unclear": [] } ] }
```

Card numbers are shared with pull requests and issues, so write every number already taken to a file beside the
draft and hand that file over:

```bash
{ gh pr list --state all --limit 1000 --json number -q '.[].number'
  gh issue list --state all --limit 1000 --json number -q '.[].number'; } > <draft>.taken
construct intake --draft <draft.json> --taken <draft>.taken [--parking <dir>] [--dry-run]
```

`construct` is the installed CLI; `npx mikoshi-construct intake …` is the same command. In the repository that
builds construct, run it from the sources instead, `pnpm --silent dev intake --draft … --taken …`, so a global
older than the sources is not the only way in. The parking defaults to `~/.construct/parking`, outside the
repository, so an attached repository gets no file from this step.

`construct intake` checks each card against the repository `--dir` names (default: the current directory) and
against the journal (`--journal`, default `~/.construct/handoff/ghosts.jsonl`), and corrects what they settle: a
`touches` path that does not exist, a `depends` or `blocks` on a task already in main — an implement task whose
`event:merge` line is in the journal, or a probe closed by its report. A card with a correction is not parked until
a person has seen it:

- Without corrections, the cards are parked at once, exit `0`.
- With corrections, nothing is parked: every card is printed with its `corrected:` lines and a token, exit `2`.
  Show the person the held cards and their corrections. Once they confirm, run the same command again with
  `--confirm <token>`; a token for a different list of corrections is refused as stale and parks nothing.
- `--auto-confirm` accepts corrections in advance and parks at once. It is off by default; use it only when the
  person asked for it.

Every parked card gets an `intake` line in the journal, with its confirmation (`none`, `person` or `auto`) and its
corrections. A confirmed card keeps the `who` of the draft: confirmation, not `who: window`, is what holds a
corrected card back. Only an unclear field sets `who: window`.

## 4. The queue is frozen

A lane is a parking directory directly under the parking root named `lane-<n>` or by date (`2026-10-09-a`); the
queue is every card in a lane when `construct intake --admit <lane>/<id>.md` runs. The queue is frozen at its
current composition: a new card enters a lane only if its body carries the line `Решение: Law` or it blocks a card
already in the queue. `--admit` refuses any other card in a lane and names the axes to park it under instead:
`autonomy`, `cost`, `self-learning`, `interface`, `architecture`. Slice that work with
`--parking <parking root>/<axis>`; a card already admitted is amended in its lane as before.

## 5. Report

Report each card line `construct intake` printed and every `corrected:` and `unclear:` line under it. On exit `2`,
report the held cards, their corrections and the token, and wait for the person before running `--confirm`. If it
refused, report its reasons and fix the draft; never edit a written card to get past the grammar.

This skill slices and hands over; `construct intake` checks and holds. It does not start a task.

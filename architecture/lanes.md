# Lanes and the dispatcher

What a lane is and who decides what goes into it. This document is a contract, not a mechanism: the
mechanism lives in `scripts/` (the factory side), and `src/` is not touched by it. The dispatcher
itself is a separate MORSE card, taken after the first autonomous night
(`parking/notes/morse-dispatcher.md` in the parking area). This document does not simulate dispatching
through metadata: no field below assigns, orders or schedules a card.

## A lane serializes cards that cannot work at the same time

A lane holds the cards that cannot safely work at the same time. What makes two cards unsafe together
is an overlap of their touches; nothing else puts two cards in one lane.

Today's mechanics, as facts:

- `scripts/shift/parking.ts:92` (`choose`) reads the cards of one lane, the directory a shift is given
  with `--parking`, and at `scripts/shift/parking.ts:97` leaves a card whose touches conflict with an
  already chosen one (`taskConflicts`, `scripts/shift/overlap.ts:49`).
- `src/commands/intake/move.ts:68` creates the lane directory when `construct intake --move --to`
  names one that does not exist yet.
- `scripts/bus/admissions.ts:64` (`parkingLane`) finds the lane of a card as the parking directory that
  holds `<id>.md`.

## Writing and review are not lane types

A lane has no type. Writing and review are not kinds of lane. Review is a separate queue on the bus,
with a bounded throughput, and a card waiting for review does not occupy a lane for it.

## MORSE decides parallelism, assignment and order

MORSE decides how many lanes run in parallel, which card goes into which lane, and the order in which
cards are launched. It weighs two things: file conflicts between cards, and the load on the review
queue.

## The minimal lane.json

A lane is described by `lane.json` with exactly these fields, and no others:

```json
{ "purpose": "…", "touches": ["…"], "createdBy": "…", "createdAt": "…", "status": "…" }
```

There is no taxonomy by contour or by kind of work: a lane is not classified as cheap or ladder,
writing or review.

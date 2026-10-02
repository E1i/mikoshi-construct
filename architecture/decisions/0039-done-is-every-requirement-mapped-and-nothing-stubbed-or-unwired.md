# 0039 — Done is every requirement mapped and nothing stubbed or unwired

Status: accepted · 2026-10-02

## Context

A ladder run is judged by witnesses, and a witness proves what it was written to prove. Nothing
mechanical asked the two questions a reader asks of a finished change: is every requirement of the
brief done by a line of code that a live test reaches, and is any function the change added a stub, or
an implementation nothing outside its own test calls? A function that returns a literal and ignores
its parameters passes a test written against that literal, and a real function that only its test
imports passes every test and does nothing in the product.

Which line of code and which test satisfy a requirement is judgment. Whether the line exists, whether
the test is live and reaches it, and whether a function is a stub or has a caller are not.

## Decision

1. **A review of a ladder run starts with `pnpm done:check`.** It takes the brief's
   `.construct/implement-args.json`, a requirement map and the base sha, and decides only what is
   mechanical: the map covers every requirement, every citation resolves in the tree, each cited test
   is a live test that reaches the cited code, and no named function the change adds or cites is a
   stub or unwired. It runs no test and executes nothing of the tree.
2. **The result is only PASS or FAIL.** A FAIL makes the review's verdict candidate FAIL, whatever the
   witnesses and the mutations show. There is no warning and no partial pass; an input the check
   cannot read is a FAIL with an `input:` line.
3. **A PASS lists the functions it cleared by name under `checked by name only`.** A function is
   cleared because its name appears in a non-test file, so a colliding name clears it too; the list is
   where a reader sees the cases in which the PASS can be false. A FAIL never prints it.
4. **The check lives in the review, not in the ladder,** until it has caught a real stub or unwired
   function. The cheap path is outside it.

## Consequences

- The reviewer writes the requirement map, never the implementer. The implementer would grade its own
  work, and the map is where judgment sits.
- A stub counted as done and an implementation wired to nothing each fail with a line naming the
  function, in a section of its own.
- A named function the change adds is checked whether or not the map cites it; a function in a changed
  file that the change left untouched is not.
- The check can be false in both directions: a colliding name clears an unwired function, and a stub
  that reads its parameters is not seen. v0.1 states the first in its PASS and accepts the second.

## Enforced by

- L1 review for running the step: the review agent starts with it, and nothing blocks a merge on it.
- L3 tests for the checker itself (`scripts/tests/done/check.test.ts`, under `pnpm run quality`).

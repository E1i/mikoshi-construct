# Code matrix

Status: a convention of this repository, not a numbered decision. Adopted on 2026-09-23 after a trial
of five pull requests; see *Trial* below. Session rules for this repository only; nothing here is
materialized into other repositories.

A report on a pull request in this repository ends with a compact matrix over its alphabet: the upper
triangle, one sign per cell, and a count line `■ n □ n · n`. A cell is expanded only on request.

## Alphabet

**Four common rules, in every matrix:**

| Code | Rule |
|---|---|
| 7A | An acceptance is red before the code exists and red under a named wrong implementation ([0027](decisions/0027-an-acceptance-is-red-before-the-implementation-exists.md), [0029](decisions/0029-an-acceptance-is-red-under-a-named-wrong-implementation.md)). |
| BD | A prediction is written down before the result. |
| E9 | Which mechanism produced the knowledge: a measurement, a reading of code, a run, a review. Authorship of files (a sha, a block marker) is a question of removal authority, not of E9. |
| FF | A loud refusal with its own reason instead of a silent wrong value. |

**Up to two further rules, only when the brief of that pull request declares them.** A rule nobody
declared is not in the matrix. Two such rules came out of the common alphabet at the end of the
trial, because they only ever met attach and detach, and they can be declared again by code:

| Code | Rule |
|---|---|
| 1C | No record, no right to remove. |
| 55 | The exclude block is a zone of visibility, not a record. |

## Signs

| Sign | Meaning |
|---|---|
| ■ | Confirmed by a red run: a test or a mutation. |
| □ | An artifact is cited, and nothing checked it. |
| · | Not considered. It does not mean the two rules do not meet. |

A cell carries a conclusion the two rules give together and the artifact that holds it: a test name, a
line of a pull request description, a prediction, a message. With no artifact, the cell is `·`.

## Trial

Five pull requests, recorded over the six rules the format started with, and one more recorded
before the decision was written down. The table is closed and is not kept any further.

| Pull request | ■ | □ | · |
|---|---|---|---|
| #170 verify-published waits for the tarball to reach the CDN | 4 | 0 | 11 |
| #173 detach reads recordVersion (0030, part A) | 5 | 0 | 10 |
| #175 characterize exit codes and --help (0030, B0) | 1 | 1 | 13 |
| #176 command definitions in src/program.ts, exit codes in tables (0030, B) | 2 | 0 | 13 |
| #177 attach and detach guide, exit table read from the characterization | 0 | 2 | 13 |
| #178 pnpm probe exempt from one selector; CLI runtime label | 3 | 0 | 12 |

The five trial rows sum to ■ 12, □ 3, · 60. With #178, the six rows sum to ■ 15, □ 3, · 72.

**Decision, 2026-09-23: keep it,** with the alphabet above. Over the six rows, 1C was marked twice
(#173 and #177) and 55 once (#177), all three on attach and detach, so both move from the common
alphabet to the declarable rules.

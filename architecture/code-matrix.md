# Code matrix

Status: trial for five pull requests, then a decision to keep or remove it. Session rules for this
repository only; nothing here is materialized into other repositories.

A report on a pull request in this repository ends with a compact matrix over the six rules below:
the upper triangle, one sign per cell, and a count line `■ n □ n · n`. A cell is expanded only on
request.

## Rules

| Code | Rule |
|---|---|
| 1C | No record, no right to remove. |
| 55 | The exclude block is a zone of visibility, not a record. |
| 7A | An acceptance is red before the code exists and red under a named wrong implementation ([0027](decisions/0027-an-acceptance-is-red-before-the-implementation-exists.md), [0029](decisions/0029-an-acceptance-is-red-under-a-named-wrong-implementation.md)). |
| BD | A prediction is written down before the result. |
| E9 | Which mechanism produced the knowledge: a measurement, a reading of code, a run, a review. Authorship of files (a sha, a block marker) is 1C, not E9. |
| FF | A loud refusal with its own reason instead of a silent wrong value. |

## Signs

| Sign | Meaning |
|---|---|
| ■ | Confirmed by a red run: a test or a mutation. |
| □ | An artifact is cited, and nothing checked it. |
| · | Not considered. It does not mean the two rules do not meet. |

A cell carries a conclusion the two rules give together and the artifact that holds it: a test name, a
line of a pull request description, a prediction, a message. With no artifact, the cell is `·`.

## Used in

Each row is added in the pull request whose report carries the matrix. The fifth row is where the
decision is taken.

| Pull request | ■ | □ | · |
|---|---|---|---|
| #170 verify-published waits for the tarball to reach the CDN | 4 | 0 | 11 |
| #173 detach reads recordVersion (0030, part A) | 5 | 0 | 10 |
| #175 characterize exit codes and --help (0030, B0) | 1 | 1 | 13 |
| #176 command definitions in src/program.ts, exit codes in tables (0030, B) | 2 | 0 | 13 |
| #177 attach and detach guide, exit table read from the characterization | 0 | 2 | 13 |

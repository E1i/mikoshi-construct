---
"mikoshi-construct": minor
---

`construct doctor` names the version that materialized the repository, the version reading it, and how many recorded paths a `sync` would add or update. The count is the sync engine's own classification — doctor replays and counts the paths classified `add` or `update` rather than asking the same question a second way, so the number it prints and the number `sync` acts on cannot drift apart. A replay it cannot run reads as "cannot be established" instead of as zero.

It is evidence on the baseline check, not a sixth gate: no level, no part of the weakest link, no change to any exit code. A baseline that has moved on is work that became available with a release, which is also why `docs/cli.md` now says plainly that a non-zero `sync` exit after a release is not a fault and that `sync` does not belong in a quality gate.

---
"mikoshi-construct": minor
---

`construct attach` (alias `jack-in`): the reasoning-budget carriers for a repository the construct did not write

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

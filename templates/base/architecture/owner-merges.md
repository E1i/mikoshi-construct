# Owner-merged kinds (data)

**Only the owner edits this file.** It draws the owner's boundaries: the kinds of pull request the owner merges. The
coordinating window and the factory read it before they merge anything, and the bus reads the column «merges under a
shard» before it looks at a shard or a decision. It is an authority axis, not a task class. Nothing here is inferred:
a kind is on this list because the owner put it here. This is the default the construct writes; the owner adds, narrows
or removes kinds.

Rule of application: **the owner merges a pull request if at least one file it changes matches at least one glob of a
kind marked `no`; an empty cell means the kind is not checked by paths.** (`release` is matched by its title.) A value
other than `yes` or `no` on a kind the pull request falls under, a missing column, or a table that cannot be read
leaves the pull request the owner's.

| kind | paths (globs) | what it covers | merges under a shard |
|---|---|---|---|
| release | — (matched by title: «chore: version packages») | version pull requests | no |
| own-instructions | `.claude/**`, `architecture/owner-merges.md` | this repository's own agent instructions, and this file, which draws the owner's boundaries | no |
| agent-permissions | `.claude/settings*.json` | what the agents in this repository may run | no |
| workflows | `.github/workflows/**` | every GitHub Actions workflow: what CI runs, with which permissions and secrets | no |
| security-invariants | `architecture/security-invariants.md` | the security invariants and the check that enforces each | no |

Everything else is merged by the window that gated it, under a shard.

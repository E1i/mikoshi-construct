# Owner-merged kinds (data)

**Only Eli edits this file.** A window reads it to decide whether a pull request is armed for auto-merge or reported as
"ready at sha X" for Eli to merge. It is an authority axis, not a task class. Nothing here is inferred: a kind is on
this list because Eli put it here.

Written by window A on 2026-09-27 at Eli's instruction, copying the list Eli settled on 2026-09-27. The paths column and the
kind `ghosts` were added the same day, also at Eli's instruction, with Eli's globs. Moved unchanged into the repository on
2026-09-28 at Eli's instruction. From now on, only Eli changes it.

Rule of application (Eli, 2026-09-27, written by window A at Eli's instruction): **Eli merges a pull request if at least
one file it changes matches at least one glob of a kind; an empty cell means the kind is not checked by paths.** (`release`
is matched by its title.)

| kind | paths (globs) | what it covers | example |
|---|---|---|---|
| release | — (matched by title: «chore: version packages») | version pull requests | PR #259, PR #265, PR #277 |
| own-instructions | `.claude/**`, `scripts/construct/**`, `templates/ai/claude/**` | the agent's own working instructions: the implement skill, the agent files (`implementer.md`, `harness.md`, `architect.md`), the ladder script, `check-acceptance` — in the repository or in `templates/ai/` | PR #244, PR #282; issues #257, #269, #271 |
| release-workflow | `.github/workflows/release*.yml` | `.github/workflows/release.yml` and what it runs for publishing | — |
| security-invariants | `architecture/security-invariants.md`, `templates/**/security-invariants.md` | `architecture/security-invariants.md` and the template copies | — |
| new-write-path | — (not checked by paths: decided by the owner) | a new path that `init` or `attach` writes: a new carrier, a new baseline file, anything that grows `ATTACH_CARRIERS`, `paths.attach.writes` or `paths.init.*` | PR #218 |
| ghosts | `scripts/ghosts/**` | the Ghost launcher (window E's brief) | — |

Everything else is merged through auto-merge by the window that gated it, including `quality`/CI gates and `formats.*`
bumps. Branch protection is a GitHub setting that Eli applies.

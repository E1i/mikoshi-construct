# 0035 — attach guards the direct commit

Status: proposed · 2026-09-30

## Context

`attach` brings the ladder into a repository the team owns, on the promise that the agent changes the
working tree and leaves no tracked change of its own (`Attached-Construct` trailer, "left no tracked
change"). Nothing enforced the other half of that promise: an agent in the session could `git commit`,
`git push`, merge, rebase or tag in the attached repository, and what reached the history was then no
longer what its owner had read.

## Decision

1. **attach installs a Claude Code `PreToolUse` guard, and detach removes exactly that.** The guard is
   `.construct/commit-guard.mjs`, from the template group `templates/attach/`, used by attach only. It
   is ESM, imports only `node:` builtins and spawns only `git rev-parse`. It is registered by one
   element in `hooks.PreToolUse` of `.claude/settings.local.json`, the untracked, per-user settings
   file, and never in a tracked `.claude/settings.json`. The guard is the parent of its own directory:
   the repository it protects does not depend on `$CLAUDE_PROJECT_DIR` or on where the session started.
2. **It is a guard against the direct form, not a sandbox.** It reads the one command the agent typed.
   A commit inside a script, an alias, `bash -c "…"` or an `eval` passes, and so does a call to any
   other tool. What it promises is that the agent that types `git commit` into the attached repository
   is refused, with exit 2 and the what / why / next lines.
3. **Five subcommands are guarded, exactly:** `commit`, `push`, `merge`, `rebase` and `tag`. `cherry-pick`,
   `revert`, `am`, `commit-tree` and `stash` pass, into any repository: they move the working tree or
   the index, or create objects no ref points to, and the owner sees the result before anything reaches
   the history.
4. **A named list of forms passes even in the attached repository:** a bare `git tag`, `git tag -l` and
   `git tag --list`, each with patterns that do not start with a dash, `git merge --abort` and
   `git rebase --abort`. They only list or undo, and refusing them would strand an agent in a merge or
   a rebase it did not start. A form matches exactly, argument for argument, never as a prefix: `git tag
   -list-something`, `git tag -d`, `git tag -l x -d y`, `git merge --continue`, `git rebase --continue`
   and `git rebase -i` are refused. The list is `ALLOWED_FORMS` in the guard, and nothing else holds it.
5. **The target is read, not guessed.** The guard follows `git -C`, `git -c`, `--git-dir`, a leading
   `cd`, a subshell, `env`, an assignment, and worktrees of the attached repository, which share its
   git directory. A guarded command whose target it cannot pin down — a path in a variable, `cd -`, a
   substitution, a directory that does not exist yet — is refused as unpinned and told to name the
   repository as `git -C <path>`; into another repository it then runs as before.
6. **No bypass.** The guard reads no environment variable to let a call through and writes no audit
   file. The owner's terminal never passes through it, so the owner already commits without it; a
   switch the agent's session can reach would let the agent commit on the owner's behalf, and an audit
   file would record a permission that should not exist. Removing the guard is `construct detach`, or
   deleting the entry by hand, which detach then names as already absent.
7. **No `if` filter on the entry.** A permission-rule prefix such as `Bash(git *)` in front of the guard
   would be a second decider beside the guard's own reading of `cd x && git commit` and `FOO=1 git push`,
   and nothing would test it. The cost is one node start per Bash call; the first attached session is
   where it is noticed if it shows.
8. **The working directory is the input's `cwd`** and nothing more. The guard infers neither the
   session's start directory nor `$CLAUDE_PROJECT_DIR`. A stale `cwd` is covered by `-C` or `cd` inside
   the command, and by the refusal of a target it cannot pin down.
9. **It fails open where it cannot check.** Input that is not a JSON object exits 1 with one line on
   stderr, a non-blocking error the user sees. Without `node` the hook errors visibly and does not block.
10. **The record moves to version 2.** `.construct/attach.json` gains `settingsHook` (the file, which of
    the file, `hooks` and `PreToolUse` attach created, and the entry as written) and the guard in
    `files`. An older detach would remove the guard and leave an entry that runs a missing file on every
    Bash call; on a version 2 record it refuses and says to upgrade the CLI. A version 1 record detaches
    as before.

## Consequences

- The `.claude/settings.local.json` edit is the one write attach makes outside what it creates: it is
  refused when the file is tracked, unreadable, or already carries a guard entry, and written by
  renaming a temporary file over it.
- detach removes the entry only when it is still the recorded element; an edited entry is refused as
  changed, a deleted one is named as already absent, and whatever else the file holds is never read for
  the decision and never removed.
- A session already running when attach writes the entry is not claimed to pick it up. That a session
  started after attach reads it, and what one node start per Bash call costs, are what the first
  attached session's manual check confirms.

What would reverse it: a way for the agent's session to be refused by the host itself, at the level of
the permission system, without a hook the agent can edit; or a measured cost of the node start that the
owners of attached repositories do not accept.

## Enforced by

- L2, a local hook: `.construct/commit-guard.mjs` refuses the direct form. Nothing enforces the forms
  point 2 names: a commit inside a script, an alias, `bash -c` or `eval`.
- L3 tests: `tests/commit-guard.test.ts` runs the installed guard over a table of refused, unpinned and
  let-through forms, each behaviour as a pair; `tests/attach.test.ts` and `tests/detach.test.ts` hold the
  settings file cases titled `the commit guard:`; `tests/attach-carriers.test.ts` keeps the carriers
  byte-identical to what `init` writes, without the guard; the guard is lint-clean under
  `@antfu/eslint-config` and a plain flat config (`tests/attach-under-target-eslint.test.ts`).
- `pnpm contract:bump` on `formats.recordVersion` and `paths.attach`.

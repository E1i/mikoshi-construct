# Working in a repository the construct did not write

`init` is for a repository that will carry a construct: it writes architecture policy, a harness,
lint and CI configuration, and appends to `CLAUDE.md` and `AGENTS.md`. A repository that already has
its own agent configuration, its own package manager and a team that did not ask for any of that
needs something smaller. `attach` (alias `jack-in`) brings only the discipline, for as long as you
need it, and `detach` (alias `jack-out`) takes it away again.

## When to use it

Use `attach` when you want `/plan` and `/implement` in a repository, and no file the team tracks may
change. Typical cases: a client's repository, a repository whose agent instructions belong to someone
else, or a first trial before anyone decides to adopt the construct.

Use `init` instead when the repository should keep the construct: a harness, a manifest, discovery
markers and a model that `doctor` can read.

```bash
cd your-repository
npx mikoshi-construct attach --harness "npm test"
# … work: claude → /plan <feature>, then /implement <task>
npx mikoshi-construct detach
```

## What attach creates, and what it leaves alone

It creates eleven files: the `/plan` command, the `/implement` skill, the three agents, the ladder
script, the acceptance check the skill runs before the ladder, the browser witness, the baseline
runner, the commit guard
`.construct/commit-guard.mjs` and the shell parser it reads the command line through,
`.construct/shell-parser.mjs`. It hides them, and `.construct/`, through a block in
`.git/info/exclude`, so `git status` stays empty. It records what it created, with a hash per file, in
`.construct/attach.json`.

It also adds one entry to `.claude/settings.local.json`, the untracked per-user settings file, that runs
the guard before every Bash call: in this repository the agent is refused `git commit`, `git push`,
`git merge`, `git rebase` and `git tag`, and leaves the change uncommitted for you to read and commit
yourself. A bare `git tag`, `git tag --list`, `git merge --abort` and `git rebase --abort` still work.
It is a guard against the direct form, not a sandbox, and it has no bypass for the agent; `detach`
removes it. attach refuses instead of editing that file when it is tracked, unreadable or already
carries a guard entry. The details are in the [CLI reference](/cli#the-commit-guard).

It leaves alone every tracked file, `CLAUDE.md` and `AGENTS.md`, your lint, test and workspace
configuration, and CI. It writes no `construct.json`, no model and no discovery markers. `.git/info/`
and the entry in `.claude/settings.local.json` are the only places outside the eleven files and
`.construct/` that it touches, and nothing there is committed.

**The harness command is never guessed.** Pass the command your repository already uses to check a
change, whatever its package manager: `npm test`, `yarn check`, `bun run ci`. Without a terminal,
`--harness` is required. `/implement` reads it back from the record.

**Authorship is not hidden.** Nothing attach writes is committed, so the report ends with a trailer to
copy into commits made during the work, `Attached-Construct: mikoshi-construct@<version>`, and one
sentence for the pull request.

## When attach refuses

Every refusal happens before anything is written. The full list with the exact output is in the
[CLI reference](/cli#the-twelve-refusals).

| Refusal | What to do |
|---|---|
| not a git repository | Run it at the root of a git repository. |
| `.git` is a file | You are in a worktree or a submodule. Run it in the main checkout; worktrees are not supported yet. |
| `construct.json` is here | The repository already carries a construct. Use `sync` and `doctor`, not `attach`. |
| `.construct/attach.json` is here | The repository is already attached, even if its carriers are gone. Run `construct detach` first. |
| nothing to attach to | The directory holds only `.git` and files such as a README or a LICENSE. attach works on any stack; it needs something to attach to and a harness command. |
| paths already exist | A file attach would create is already there, and it is yours. Move it aside or keep working without attach; attach never writes over it. |
| `.claude/settings.local.json` is tracked, unreadable, or already carries a guard entry | attach will not edit it. Stop tracking it, fix it or move it aside, then attach again. |
| `--yes` without `--harness` | Pass `--harness <command>`. |
| `--ai cursor` or `both` | Not supported: a Cursor rule would apply to the whole tree. Use Claude Code. |

## Detaching

`detach` removes what the record lists, and nothing else. It reads everything before it removes
anything, so a refusal leaves the tree exactly as it was.

**Three states.** With no record and no exclude block, nothing is attached and detach says so. With a
record, it proceeds. With an exclude block but no record, it refuses: without the record it cannot
tell what the block hides from what is yours, so it prints each path in the block, marked on disk or
not, for you to remove by hand.

**Each recorded file is sorted before anything is removed.**

| Class | Meaning | What happens |
|---|---|---|
| adopted | you committed it (`git add -f`) | it is yours now; it stays, with its directory |
| already absent | you deleted it | nothing to do; it is named |
| changed | you edited it | detach refuses and removes nothing |
| to remove | untouched since attach | removed |

**When detach says a file changed**, the edit is yours and detach will not throw it away. Restore the
file if you did not mean to keep the change, or commit it if you did; a committed carrier is adopted
and stays. There is no `--force`.

**The guard entry is taken out of `.claude/settings.local.json`.** detach removes the one element attach
appended, and the file itself only when attach created it and nothing else is left in it; grants and
hooks you added stay. An entry you edited is refused as changed, one you deleted is named as already
absent, and a settings file you committed is left as it is. Run detach with a CLI at least as new as the
one that attached: an older detach refuses a `recordVersion` 2 record and removes nothing, so upgrade
the CLI (`npx mikoshi-construct@latest`) first.

**Files attach did not write stay.** `/implement` writes its run ledger to `.construct/runs.jsonl`, and
a settings file that holds more than the guard entry stays. detach names them, and once the exclude
block is gone they show in `git status` as untracked files, for you to keep or delete.

The remaining refusals, about the git index and the record, are listed with their exact output in the
[CLI reference](/cli#construct-detach), each with how to get an index detach can read.

## Limits

- **Any stack.** attach does not read the stack: a repository with something in it is attached
  whatever it is written in, and the harness command you name is the only stack-specific input.
  Nothing checks yet whether that harness covers the code: `doctor` does not read an attached
  repository
  ([decision 0034](https://github.com/E1i/mikoshi-construct/blob/main/architecture/decisions/0034-stack-detection-is-not-an-attach-gate.md)).
- **Claude Code only.** Cursor is refused.
- **No worktrees or submodules.** A `.git` that is a file is refused.
- **One attach at a time.** A second attach meets its own files and refuses with a collision; detach
  first.

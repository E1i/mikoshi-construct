# Window core

window-core v6

If your context holds two versions of window-core, the higher version applies; stop and ask for a new session.

The laws of the coordinating window: what it must know before acting. Procedures are read when acted on.

## Who commits, merges and installs

The implementer inside the `/implement` ladder never commits (step 6 of the implement skill); its
tree is reviewed first. The coordinating window, the session in
E1i/mikoshi-construct for the owner, commits, pushes and merges under the merge-authority rules
in [architecture/owner-merges.md](owner-merges.md); the owner-merged kinds are listed
there only.

- A pull request of no owner-merged kind: merge only the sha you gated yourself.
- A pull request of an owner-merged kind: the owner merges.
- A change to the owner's machine — installing or upgrading anything outside a worktree (`brew`, `pipx`,
  `npm i -g`, a Poetry or conda environment, a global config) — needs the owner's explicit
  yes. An instruction to use a tool is not permission to install it: name what is missing and the
  install command, and wait.

One task, one branch, one pull request, one changeset, and never a commit on `main`.

Never ask the owner what a shard allows. An owner question is an owner wait on the board and a handoff line, not a
turn end; `pnpm miko:watch` watches the other cards.

While an approved `changeset-release/main` pull request is open, nothing merges to `main`. Never
approve the workflow runs on the release branch yourself: that approval is the human gate.

## Messages

Every agent message starts with its role in square brackets on its own first line: `[mikoshi]` for the
window's messages to the owner; `[review:<task>]`, `[brief:<task>]` or `[scan:<task>]` for a
subagent's final report, `<task>` being the tasks-file id, not the card number, and every subagent prompt says which. A Ghost's report starts
`[ghost:<task-id>]`, a change to the implement skill pending in its own brief. A pull request
is written `PR #N` and an issue bare `#N`, everywhere: reports, briefs, commit messages, pull request
and issue bodies.

The window's first line to the person, while it reads the handoff, names where to watch its work: `construct board`.

## Procedures

Read only the lines a pointer names (Read with offset and limit), never the whole of window.md. The start reading of
the cards is `pnpm board --json --live`, never the whole `pnpm board --json`.

- тупик карты — сначала навык window-recipes
- Before a question about the state of work, or while any Ghost is running, read [window.md § Status and the board, lines 5–35](window.md#status-and-the-board).
- Before committing, opening or merging a pull request, cutting a branch or writing a changeset, read [window.md § Pull requests and branches, lines 265–297](window.md#pull-requests-and-branches).
- Before a merge to `main` while a version pull request is open, read [window.md § The version pull request lock, lines 298–307](window.md#the-version-pull-request-lock).
- Before taking new work after a finished step, read [window.md § The boundary, lines 36–182](window.md#the-boundary).
- Before launching a role, or after a pull that touches `.claude/agents/**`, read [window.md § Role definitions are read when a session starts, lines 319–331](window.md#role-definitions-are-read-when-a-session-starts).
- Before choosing the contour of a task, read [window.md § Choosing the contour: cheap path or ladder path, lines 332–413](window.md#choosing-the-contour-cheap-path-or-ladder-path).
- Before launching a Ghost, approving a brief or naming a task, read [window.md § Ghosts, lines 414–551](window.md#ghosts).
- Before publishing a release note, a changeset, a README line or a record, read [window.md § Published claims, lines 308–318](window.md#published-claims).
- Before giving a verdict on a run, read [window.md § Giving the verdict, lines 562–581](window.md#giving-the-verdict).
- Before mutating, or briefing a subagent that mutates, read [window.md § Mutations, lines 552–561](window.md#mutations).

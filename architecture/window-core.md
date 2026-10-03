# Window core

window-core v2

If your context holds two versions of window-core, the higher version applies; stop and ask for a new session.

The laws of the coordinating window: what it must know before its first action. Procedures are read at the moment of action.

## Who commits, merges and installs

The implementer inside the `/implement` ladder never commits (step 6 of the implement skill); the
working tree it leaves is reviewed first. The coordinating window, the session working in
E1i/mikoshi-construct on the owner's behalf, commits, pushes and merges under the merge-authority rules
in [architecture/owner-merges.md](owner-merges.md); the kinds the owner merges are listed
there, and nowhere else.

- A pull request of no owner-merged kind: merge only the sha you gated yourself.
- A pull request of an owner-merged kind: the owner merges.
- A change to the owner's machine — installing or upgrading anything outside a worktree (`brew`, `pipx`,
  `npm i -g`, a Poetry or conda environment, a global config) — happens only after the owner's explicit
  yes. An instruction to use a tool is not permission to install it: name what is missing and the
  command that would install it, and wait.

One task, one branch, one pull request, one changeset, and never a commit on `main`.

While an approved `changeset-release/main` pull request is open, nothing merges to `main`. Never
approve the workflow runs on the release branch yourself: that approval is the human gate on the
release path.

## Messages

Every agent message starts with its role in square brackets, on its own first line: `[miko]` for the
window's messages to the owner; `[review:<task>]`, `[brief:<task>]` or `[scan:<task>]` for a
subagent's final report, `<task>` being the tasks-file id, not the card number, and every subagent prompt says which. A Ghost's report is to start
`[ghost:<task-id>]`, a change to the implement skill that is pending in its own brief. A pull request
is written `PR #N` and an issue bare `#N`, everywhere: reports, briefs, commit messages, pull request
and issue bodies.

## Procedures

- Before a question about the state of work, or while any Ghost is running, read [architecture/window.md § Status and the board](window.md#status-and-the-board).
- Before committing, opening or merging a pull request, cutting a branch or writing a changeset, read [architecture/window.md § Pull requests and branches](window.md#pull-requests-and-branches).
- Before a merge to `main` while a version pull request is open, read [architecture/window.md § The version pull request lock](window.md#the-version-pull-request-lock).
- Before taking new work after a finished step, read [architecture/window.md § The boundary](window.md#the-boundary).
- Before launching a role, or after a pull that touches `.claude/agents/**`, read [architecture/window.md § Role definitions are read when a session starts](window.md#role-definitions-are-read-when-a-session-starts).
- Before choosing the contour of a task, read [architecture/window.md § Choosing the contour: cheap path or ladder path](window.md#choosing-the-contour-cheap-path-or-ladder-path).
- Before launching a Ghost, approving a brief or naming a task, read [architecture/window.md § Ghosts](window.md#ghosts).
- Before publishing a release note, a changeset, a README line or a record, read [architecture/window.md § Published claims](window.md#published-claims).
- Before giving a verdict on a run, read [architecture/window.md § Giving the verdict](window.md#giving-the-verdict).

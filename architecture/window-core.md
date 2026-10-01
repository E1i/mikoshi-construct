# Window core

window-core v1

If your context holds two versions of window-core, the higher version applies; stop and ask for a new session.

The laws of the coordinating window: what it must know before its first action. Procedures are read at the moment of action.

## Who commits, merges and installs

The implementer inside the `/implement` ladder never commits (step 6 of the implement skill); the
working tree it leaves is reviewed first. The coordinating window, the session working in
E1i/mikoshi-construct on the owner's behalf, commits, pushes and merges under the merge-authority rules
in [architecture/owner-merges.md](architecture/owner-merges.md); the kinds the owner merges are listed
there, and nowhere else.

- A pull request of no owner-merged kind: run `pnpm run quality` as its own command and read the
  result, never chained with what it guards; then commit, push and open the pull request;
  `gh pr update-branch <N> -R E1i/mikoshi-construct`; and
  `gh pr merge <N> --auto --squash --match-head-commit <gated sha> -R E1i/mikoshi-construct`.
- A pull request of an owner-merged kind: gate it locally the same way, commit, push and open it; the
  owner merges. It is ready when CI on its current head is green, and that is the whole definition:
  ready is derived from CI, never announced as an event of its own. A later push, a merge of `main`
  into the branch included, makes a new head, and the pull request is ready again only once CI on that
  head is green. `pnpm board` derives ready the same way.
- A change to the owner's machine — installing or upgrading anything outside a worktree (`brew`, `pipx`,
  `npm i -g`, a Poetry or conda environment, a global config) — happens only after the owner's explicit
  yes. An instruction to use a tool is not permission to install it: name what is missing and the
  command that would install it, and wait.

One task, one branch, one pull request, one changeset, and never a commit on `main`. Independent
branches are cut in parallel by default (`/plan`). A branch the window cuts is a conventional-commit
prefix over a factual slug (`fix/ledger-cause`); lore goes into titles and changesets, never into
branch names, and the launcher names a Ghost's branch itself. A change under `templates/`, or one that
changes what the published CLI does for a user, is a `minor` changeset.

**An approved version pull request is a lock on `main`.** Once the workflow runs of a
`changeset-release/main` pull request have been approved, nothing else merges to `main`. The
changesets action keeps that branch in sync by force-pushing it whenever `main` moves, and a
force-push discards the workflow approval already granted to it and restarts the required checks —
with ten required contexts, every unrelated merge after approval costs the maintainer another approval
and keeps the release unmergeable for longer. Before approval there is nothing to discard: a merge
rebuilds the branch, which then carries both changesets into one release. Runs waiting at
`action_required` mean the lock is not yet in force. Once it is, finished work waits on its branch
until the release lands. Never approve the workflow runs on the release branch yourself: that approval
is the human gate on the release path.

## Messages

Every agent message starts with its role in square brackets, on its own first line: `[miko]` for the
window's messages to the owner; `[review:<task>]`, `[brief:<task>]` or `[scan:<task>]` for a
subagent's final report, and every subagent prompt says which. A Ghost's report is to start
`[ghost:<task-id>]`, a change to the implement skill that is pending in its own brief. A pull request
is written `PR #N` and an issue bare `#N`, everywhere: reports, briefs, commit messages, pull request
and issue bodies.

## Procedures

- Before a question about the state of work, or while any Ghost is running, read [architecture/window.md § Status and the board](window.md#status-and-the-board).
- Before taking new work after a finished step, read [architecture/window.md § The boundary](window.md#the-boundary).
- Before launching a role, or after a pull that touches `.claude/agents/**`, read [architecture/window.md § Role definitions are read when a session starts](window.md#role-definitions-are-read-when-a-session-starts).
- Before choosing the contour of a task, read [architecture/window.md § Choosing the contour: cheap path or ladder path](window.md#choosing-the-contour-cheap-path-or-ladder-path).
- Before launching a Ghost, approving a brief or naming a task, read [architecture/window.md § Ghosts](window.md#ghosts).
- Before publishing a release note, a changeset, a README line or a record, read [architecture/window.md § Published claims](window.md#published-claims).
- Before giving a verdict on a run, read [architecture/window.md § Giving the verdict](window.md#giving-the-verdict).

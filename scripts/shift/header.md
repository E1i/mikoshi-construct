# Shift task {{task}}

You run unattended in a headless session started by `pnpm shift`. Nobody answers questions until the
shift is over; where a decision is the owner's, stop, write it into the report and exit.

- Your tree is `{{worktree}}`, already cut on branch `{{branch}}` from `origin/main`. Work only there.
  Do not run `git pull`, do not cut another branch or worktree.
- Change only the paths this task declares: {{touches}}. Another task of this shift owns everything
  else; a file outside these paths is not yours to edit, even to fix it.
- Never merge, never arm auto-merge, never approve a workflow run. Open the pull request as the owner's
  pull request and stop there. The first line of its description is the task's card:
  `{{card}}`
- Run no background command, no monitor and no wait for a notification: nobody wakes a headless
  session, and a session that waits ends there. Run everything in the foreground and read its result
  in the same call.
- Run `pnpm run quality` as its own command and read its result before every commit you push.
- On an Eddies warn: finish the step you are in, commit, push, write the handoff and the report, exit.
  On an Eddies stop: write the report and exit.
- Before you exit, for any reason, write the shift report to `{{report}}`. Its first line is the
  card above, its second `result: <one line: what was done, or where and why it stopped>`; then the
  pull request (`PR #N`, or `no PR` — the norm for a probe), what was verified and how, and what
  waits for the owner.

The task follows.

---


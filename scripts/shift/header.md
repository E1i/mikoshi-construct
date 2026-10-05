# Shift task {{task}}

You run unattended in a headless session started by `pnpm shift`. Nobody answers questions until the
shift is over; where a decision is the owner's, stop, write it into the report as a
`question: <what the owner decides>` line and exit.

- Your tree is `{{worktree}}`, already cut on branch `{{branch}}` from `origin/main`. Work only there.
  Do not run `git pull`, do not cut another branch or worktree.
- Change only the paths this task declares: {{touches}}. Another task of this shift owns everything
  else; a file outside these paths is not yours to edit, even to fix it.
- Never approve a workflow run and never run `gh pr merge` yourself. The first line of the pull request's
  description is the task's card:
  `{{card}}`
- Run no background command, no monitor and no wait for a notification: nobody wakes a headless
  session, and a session that waits ends there. Run everything in the foreground and read its result
  in the same call.
- Run `pnpm run quality` as its own command and read its result before every commit you push.
- On an Eddies warn: finish the step you are in, commit, push, write the handoff and the report, exit.
  On an Eddies stop: write the report and exit.
- Before you exit, for any reason, write the shift report to `{{report}}`. Its first line is the
  card above; then one line each, in this order: `contract: <kind, contour, decision, touches, the
  law the task answers to, or what is not recorded>`, `expect: <the forecast, or expect not
  recorded in <where>>`, `action: <what was run>`, `result: <one line: what was done, or where and why it
  stopped>`; then the pull request on a line of its own (`PR #N`, or `no PR` — the norm for a probe), then
  `verification: <word>` on a line of its own, the word one of `measurement`, `code-reading`, `run`,
  `review`, `mutation`, `browser`, `human-gate`, then what was verified and how, and what waits for the
  owner. The shift closes the task from the `PR #N` and `verification:` lines; do not run `pnpm task:close`
  yourself.

The task follows.

---


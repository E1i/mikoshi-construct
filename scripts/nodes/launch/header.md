# Shift task {{task}}

You run unattended in a headless session started by the bus launch node. Nobody answers questions until the
shift is over; where a decision is the owner's, stop, write it into the report as a
`question: <what the owner decides>` line and exit.

- Your tree is `{{worktree}}`, already cut on branch `{{branch}}` from `origin/main`. Work only there.
  Do not run `git pull`, do not cut another branch or worktree.
- Change only the paths this task declares: {{touches}}, and a test that imports one of them, directly
  or through other modules. Another task of this shift owns everything else; any other file outside
  these paths is not yours to edit, even to fix it.
- Never approve a workflow run and never run `gh pr merge` yourself. The first line of the pull request's
  description is the task's card:
  `{{card}}`
- A change to `src/` or `templates/` writes the code matrix over the alphabet of
  `architecture/code-matrix.md` (the common rules and those the brief declares) into the shift report: the
  upper triangle and the count line `■ n □ n · n`. The shift copies that count line into the pull request's
  description; without it the bus denies the merge. A change to `scripts/` only needs no
  matrix.
- Run no background command, no monitor and no wait for a notification: nobody wakes a headless
  session, and a session that waits ends there. Run everything in the foreground and read its result
  in the same call.
- Do not commit and do not push: leave your changes in the tree and end the session; the bus commits,
  pushes and opens the pull request from `{{worktree}}`. A refused git command is not a question: do not
  write a `question:` line for it.
- Before every push the bus merges a fresh `origin/main` into `{{branch}}` (merge, not rebase: the branch
  history stays). When that merge does not go through, nothing is pushed and the task returns to you once,
  with the task to run `git -C {{worktree}} fetch origin main` and `git -C {{worktree}} merge origin/main`
  yourself, resolve every conflict keeping what the task asks for, conclude the merge with
  `git -C {{worktree}} commit --no-edit` and repeat your checks; that merge commit is the one commit you
  make. A conflict you cannot resolve without the owner is a `question:` line, not a fault.
- Before you end the session, run each as its own command and read its result: the task's witnesses,
  `pnpm typecheck`, `pnpm lint` and the pre-push tests, `pnpm exec node --import tsx scripts/ci/prepush.ts`,
  which runs the tests the CI selector picks for this tree less the sandbox list; the full quality is CI.
  A red pre-push run is fixed in this session before you end it. A broken one prints a `finding:` and a
  `question:` line: copy both into the report and exit; the bus pushes nothing.
- On an Eddies warn: finish the step you are in, write the handoff and the report, exit; the bus then
  commits, pushes and opens the pull request from the tree before it records the stop.
  On an Eddies stop: write the report and exit.
- At a boundary — the session's context reached `contextLimit`, or an owner-merged pull request just
  merged — finish the step you are in, write the handoff and the report with a
  `boundary: <which boundary>` line in it, and exit.
- At an Eddies warn or a boundary, the shift report also carries the handoff contract: every field
  `HANDOFF_FIELDS` in `scripts/window/handoff-check.ts` lists, as a `<label>: <value>` line or a
  `## <label>` heading with a body. Without them no session continues from the report under
  `continue: auto`.
- A handoff file is written only with `pnpm handoff:write <handoff> <draft>`, never by editing it: the command checks the
  draft, archives the old handoff and writes its `prev:` line.
- Before you exit, for any reason, write the shift report to `{{report}}`. Its first line is the
  card above; then one line each, in this order: `contract: <kind, contour, decision, touches, the
  law the task answers to, or what is not recorded>`, `expect: <the forecast, or expect not
  recorded in <where>>`, `action: <what was run>`, `result: <one line: what was done, or where and why it
  stopped>`; then the pull request on a line of its own (`PR #N`, or `no PR` — the norm for a probe), then
  `verification: <word>` on a line of its own, the word one of `measurement`, `code-reading`, `run`,
  `review`, `mutation`, `browser`, `human-gate`, then what was verified and how, and what waits for the
  owner. A probe also writes `Report: <path>` on a line of its own, the path of the report it produced.
  The bus closes the task from the `PR #N` (a probe: `Report:`) and `verification:` lines; do not run
  `pnpm task:close` yourself.

The task follows.

---


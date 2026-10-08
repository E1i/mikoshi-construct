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
- A pull request that changes `src/` or `templates/` ends its description with the code matrix over the
  alphabet of `architecture/code-matrix.md` (the common rules and those the brief declares): the upper
  triangle and the count line `■ n □ n · n`. Without that line `pnpm shift:merge` arms nothing. A pull
  request that changes only `scripts/` needs no matrix.
- Run no background command, no monitor and no wait for a notification: nobody wakes a headless
  session, and a session that waits ends there. Run everything in the foreground and read its result
  in the same call.
- Run `pnpm run quality` as its own command and read its result before every commit you push.
- On an Eddies warn: finish the step you are in, commit, push, write the handoff and the report, exit.
  On an Eddies stop: write the report and exit.
- At a boundary — the session's context reached `contextLimit`, or an owner-merged pull request just
  merged — finish the step you are in, commit, push, write the handoff and the report with a
  `boundary: <which boundary>` line in it, and exit.
- At an Eddies warn or a boundary, the shift report also carries the handoff contract: every field
  `HANDOFF_FIELDS` in `scripts/ghosts/handoff-check.ts` lists, as a `<label>: <value>` line or a
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
  The shift closes the task from the `PR #N` (a probe: `Report:`) and `verification:` lines; do not run
  `pnpm task:close` yourself.

The task follows.

---


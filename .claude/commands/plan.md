---
description: Turn a feature or issue into tasks that /implement can run — each with a statable acceptance criterion and an effort class.
argument-hint: <feature, issue text or link>
---

Decompose `$ARGUMENTS` into tasks for the reasoning-budget ladder. Use the `architect` agent for the
decomposition when the feature touches a contract, a composition model, a high-effort area from
CLAUDE.md or a security invariant; otherwise reason it out directly.

Rules:

- Two to six tasks. Each task is independently verifiable by the harness and leaves the tree green.
- Each task has two to four acceptance criteria that a harness run or a test can confirm. "Works" is
  not a criterion; "GET /v1/things returns 200 with the `Thing` schema and the contract test passes" is.
- A criterion is verified by what the task changes itself. If satisfying it needs an action outside the
  task, it belongs to that task, not this one.
- Where a criterion can fail against the repository as it stands, show it failing before the change
  is made. A criterion first run after the implementation cannot tell a change that worked from one
  that was never needed.
- When a task's brief has a Design, every line of it — and every case a line lists — is held by a
  should / should-not witness pair or fixture pair. Before the brief goes for approval, its author
  checks it line by line, Design line → witness, and names the witness for each; a Design line no
  witness holds is given one or removed. A ladder can finish `done` with an unwitnessed Design line
  never implemented.
- Order tasks so the contract and composition changes come first, then implementation, then anything
  that consumes the new behaviour.
- Independent tasks run in parallel by default. Tasks whose write contours (the files and trees they
  write) do not intersect and that do not need each other's results are planned and run in parallel:
  subagents for reviews, checks and brief preparation; separate sessions or worktrees for
  implementation. A task is sequential only when it shares a write resource with another (the same
  tree or file) or needs another's result, and the plan says which in one line.
- Classify each task `low`, `medium` or `high` with the rules in `architecture/principles.md`
  (Reasoning budget); a task touching a high-effort area, the contract, a composition model, the
  dependency policy or a security invariant is `high`.
- If the feature is ambiguous about a contract or a boundary, put one precise question first and stop
  after it; do not plan on a guess.

Output the tasks as a numbered list; for each, one line `/implement <task> — acceptance: …; effort:
<class>` that can be pasted as-is. Do not implement anything.

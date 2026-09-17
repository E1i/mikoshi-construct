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
- Order tasks so the contract and composition changes come first, then implementation, then anything
  that consumes the new behaviour.
- Classify each task `low`, `medium` or `high` with the rules in `architecture/principles.md`
  (Reasoning budget); a task touching a high-effort area, the contract, a composition model, the
  dependency policy or a security invariant is `high`.
- If the feature is ambiguous about a contract or a boundary, put one precise question first and stop
  after it; do not plan on a guess.

Output the tasks as a numbered list; for each, one line `/implement <task> — acceptance: …; effort:
<class>` that can be pasted as-is. Do not implement anything.

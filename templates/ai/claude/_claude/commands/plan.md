---
description: Turn a feature or issue into tasks that /implement can run — each with a statable acceptance criterion and an effort class.
argument-hint: <feature, issue text or link>
---

Decompose `$ARGUMENTS` into tasks for the reasoning-budget ladder. Use the `architect` agent for the
decomposition when the feature touches a contract, a composition model, a high-effort area from
CLAUDE.md or a security invariant; otherwise reason it out directly.

Choose each task's contour before anything else: the cheapest one that yields the proof the task needs
([architecture/principles.md](../../architecture/principles.md), Reasoning budget).

- **Cheap path**: an ordinary session, the harness and CI, with no brief, no witnesses and no mutations.
  It fits docs and comments, cosmetics and naming, a one-file change with its local test, and a small
  fix that an ordinary test proves directly.
- **Ladder path**: a brief with witnesses, run by `/implement`. It fits a change to the workflow's own
  mechanism, a result that needs a separate red-before or positive-control witness, several independent
  surfaces, unattended or parallel work, and a case where an ordinary test cannot rule out a specific
  incorrect way of doing it.
- Never choose the ladder only because a task entered this workflow: the price of the proof matches
  the risk. When the contour is not obvious, estimate it briefly first. The cheap path keeps CI and the
  repository's merge rules.
- The rules below on briefs and witnesses apply to ladder-path tasks.
- A task is never done twice. The brief proves the witnesses are executable (byte-identical, `bash -n`,
  red on the base for a behavioural reason) and does not implement the task. If the implementation is already done and proven by the witnesses, it becomes the pull request; a separate implementer does not repeat it.

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
  never implemented. The author also checks that the Design and the Invariants do not contradict each
  other.
- A Design names every file its own decisions force, such as a test that guards a list the change
  extends or a generated file the change makes stale.
- Before a brief goes for approval, each witness is run as the ladder will run it: `bash -n` accepts
  it, and `bash -c` on the base exits non-zero for a behavioural reason, not a missing tool or
  dependency. Where a known correct solution exists (an earlier attempt's patch, a sketch), the
  witness goes green on it. A brief is not changed after approval; any change sends the full text back
  for a new approval.
- The fixtures and scripts a brief's witnesses run against are merged into the base before its ladder
  starts. Approval may come earlier, when the witnesses were checked on the tree that holds them.
- Witnesses:
  - A witness that loops over variants also proves the variants differ where it runs.
  - A claim that nothing changed starts from a populated state and carries a probe the operation
    would visibly disturb. Better still, restate "did not change" as "cannot come from there": a
    derivation is checkable at one point in time.
  - Ask what would force a line to be edited. If that is not the property asserted, the line is a
    snapshot.
  - A comparison across runs sits across the run where the defect first appears: the first against
    the second catches a defect that settles on a wrong value, which later runs never show.
  - A fix prompted by a symptom also covers what runs through the same mechanism without a symptom,
    and its test demands that something be said, not that nothing is.
  - Assert the property that was violated, not the text of the config line that broke.
  - Construct the forbidden state rather than exercising only the healthy one.
  - A requirement about rendered text says what the line must contain in each state it can be in.
  - A set that stands in for a real process's effects is taken from a recorded real run, and dropping
    one member is a mutation that turns the check red.
  - A predicted mutation changes one thing.
- Order tasks so the contract and composition changes come first, then implementation. When a
  producer and its consumer ship in separate tasks, what passes between them decides the order. For a
  data format (a record, a file, a field) the reader ships first: a reader with nothing to read says
  so, while a writer with no reader emits records nothing shows. For a behaviour, the consumer ships
  last, after the behaviour it consumes.
- A deferral ("in parallel", "later", "a separate track") is a task with its own criterion, or the
  deferred work has no producer.
- The lint rule that constrains a new module's imports ships in the task that first names the module,
  with a probe that adds the forbidden import and is shown to be reported.
- Work that spans several tasks gives its half-done state a value of its own in the data, and the task
  that finishes it carries a test that no member still holds that value.
- A verification worth doing is a committed test with its own criterion and its place in the order,
  never a one-off run before the work.
- Independent tasks run in parallel by default. Tasks whose write contours (the files and trees they
  write) do not intersect and that do not need each other's results are planned and run in parallel:
  subagents for reviews, checks and brief preparation; separate sessions or worktrees for
  implementation. A task is sequential only when it shares a write resource with another (the same
  tree or file) or needs another's result, and the plan says which in one line.
- Classify each task `low`, `medium` or `high` with the rules in `architecture/principles.md`
  (Reasoning budget); a task touching a high-effort area, the contract, a composition model, the
  dependency policy or a security invariant is `high`. What makes it `high` is what it touches, and
  what `high` requires is a design before any implementation. Plan such a task as its design step
  followed by `medium` implementation tasks, each carrying the settled design attached as its Design; a
  task that is large but already designed is cut this way, not escalated.
- If the feature is ambiguous about a contract or a boundary, put one precise question first and stop
  after it; do not plan on a guess.

Output the tasks as a numbered list. A ladder-path task is the full skeleton of its brief, in the shape
the `/implement` build turns into args, filled in so it can be pasted as-is:

```text
/implement <the task in one sentence>

Effort: <low|medium|high> — <one-line reason>

Design:
- <a decision the implementation must follow>

Acceptance: <a criterion, red on the base and green after the change> — witness: `<command>`; <the next criterion> — witness: `<command>`

Invariants: <what is green before and after the change>

Immutable: <a path the change may not touch>; <a directory, ending in />
```

Each acceptance item ends with its witness, and `; ` separates the items. `Design:` is left out when the
task carries no design. A cheap-path task is one line, `<task> — acceptance: …; effort: <class>`. Do not
implement anything.

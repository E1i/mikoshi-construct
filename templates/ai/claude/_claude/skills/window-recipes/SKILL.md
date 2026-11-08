---
name: window-recipes
description: A card's dead end, looked up before it is reasoned about — a card stands still, a dead end, not its own lane, outside touches, a question that does not close, a PR with no card, a conflict, the merge queue holds. Each row is the situation, its sign in the bus, the command and who runs it.
---

| Situation | Sign in the bus | Command | Who |
|---|---|---|---|
| A card waits behind a lane, not its own | `card.admitted` and no `card.started`; an open PR holds the lane as a running card does, and reflow moves only into a lane with no live card | `construct-intake --move '#N' --to lane-K` | window |
| Outside touches | `card.stopped` with `question.agent` or `question.owner` naming a file outside the touches, and no live session on the card | `construct-intake --amend '#N' --touches +<path>` | window |
| A question that does not close: the amend or the decision is in, the wait stays open | the owner wait is still open after the `card.admitted` or the decision, and no answer task is queued | `miko request owner.wait.close --id Q<N> --answer <the owner's word> --from answer` | window |
| A question only the owner can close | the close comes back `window.request.refused`: it stays the owner's | `construct say "<the owner's words>"` | owner |
| The merge queue holds behind an open question | `policy.denied` `owner_question_open` repeating on the merge task at the head of the queue, and no other PR merges | `construct say "<the owner's words>"` | owner |
| The merge queue holds a PR that keeps needing an update | `policy.denied` `needs_update` twice in a row on one PR: see that the update node takes it | `miko watch --once` | window |
| The merge queue dropped a PR for its body | the merge task is withdrawn: the PR changes published code and its body has no count line | `miko request pr.body --pr <N>` | window |
| A card stands still: its task will not come back | a `board.alarm` names the task; without an alarm the requeue is refused, and that refusal is normal | `miko request requeue --task <task_key>` | window |
| A card stands still on a witness downgrade | `card.waiting` `witness.downgrade`, then answer rounds ending `question.agent` with the same question: hold it, and release it after the owner's decision | `miko request hold --card <N> --reason <why>`, `miko request release --card <N>` | window |
| A card stands still: a green tree and no PR | the answer node denies `left_nothing` or `held_for_owner`, the tree has commits ahead of its base, and no PR is recorded | `gh pr create --head <branch> --body-file <file>` | owner |
| A PR with no card | the PR's record has `card_id` null: review, answer, CI and merge never reach the card, and the card looks PR-less | `gh pr edit <N> --body-file <file>` | owner |
| A conflict | the PR is observed `dirty`, and the card stops on a question naming the conflicted file: the answer says which side stays | `miko request owner.wait.close --id Q<N> --answer <the owner's word on which side stays> --from answer` | window |

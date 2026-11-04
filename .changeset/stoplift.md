---
"mikoshi-construct": patch
---

Every `question.owner` stop now has a lift on each route. `bus:request owner.wait.close --from answer` closes the wait on the owner's word from the owner channel and lifts the stop that wait was opened with, a stop on a reservation included, because the word is the owner's; another wait of the same card lifts nothing, and without `--from answer` a window close of a reserved stop stays refused. A card amend admitted after the stop lifts it when the amend's note names the stop id or that stop's wait id (`Q<N>`); any other later amend does not. The answer node's stop on a commit refused for changes outside touches now records the refused paths in `widen`, so an amend covering them lifts the stop with no owner wait to open or close, and an answer to a red CI on an open pull request is queued again; a refused owner path records none.

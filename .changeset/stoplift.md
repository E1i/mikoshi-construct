---
"mikoshi-construct": patch
---

Every `question.owner` stop now has a lift on each route. `bus:request owner.wait.close --from answer` closes the wait on the owner's word from the owner channel and lifts the card's stop, a stop on a reservation included, because the word is the owner's; without `--from answer` a window close of a reserved stop stays refused. A card amend admitted after the stop lifts it when the amend's note names the stop id or the wait id (`Q<N>`); any other later amend does not.

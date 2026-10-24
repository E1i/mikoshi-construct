---
'mikoshi-construct': patch
---

factory: the bus no longer merges a card's pull request while an owner question of that card is open. The merge is denied with the reason `owner_question_open`, the detail names each open question by its id and text, and the merge task goes back to the queue without counting as a failure; it merges once the question is answered. A pull request GitHub already merged at the leased head is still recorded.

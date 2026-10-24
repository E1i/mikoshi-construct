---
'mikoshi-construct': patch
---

factory: a card whose pull request cannot move by itself no longer holds its lane. A card is stalled when its pull request is open, no task of the card is queued or leased, and either its merge task at the pull request's head was withdrawn (an authority denial such as `no_matrix_count_line`, or the `witness` denial) or an owner merge wait is open on the pull request. The bus raises one `board.alarm` with the reason `stalled`, naming the card, the denial's rule or reason as `cause`, and its detail. A queued card in that lane whose touches do not overlap the stalled card's, and which does not depend on it, launches. A queued card laid behind it next to another queued card moves to an empty lane. The merge decision is unchanged.

---
"mikoshi-construct": patch
---

The bus answer node no longer takes a card that the owner holds. A hold is now recorded on the bus: `pnpm bus:request hold --card <N> --reason <text>` holds a card, and `pnpm bus:request release --card <N>` releases it. The node also treats two other cases as holds: a card whose open pull request is a draft, and a card with a live session running in its tree. For a held card, the node records a `held_for_owner` denial, withdraws the task and starts no session. Before, a line in the handoff was the only hold, and the answer node did not read it. It also refuses an answer commit that changes a path outside the card's admitted touches and creates. It records an `outside_touches` denial and pushes nothing. Before, the node committed and pushed whatever the answer session left in the tree.

---
"mikoshi-construct": patch
---

The bus answer node no longer takes a card that the owner holds. A hold is now recorded on the bus: `pnpm bus:request hold --card <N> --reason <text>` holds a card, and `pnpm bus:request release --card <N>` releases it. The node also treats three other cases as holds: a card whose open pull request is a draft, a card with a live session whose working directory is in its tree, and a card whose sessions cannot be read. For a held card, the node records a `held_for_owner` denial, withdraws the task and starts no session. Before, a line in the handoff was the only hold, and the answer node did not read it.

The node also refuses an answer commit that changes a path outside the card's admitted touches and creates, plus the paths a window widening added. The check covers the files the answer session committed itself as well as what it left uncommitted. A card with no admitted body has no paths in scope, so every changed path counts as outside. On a refusal the node pushes nothing, leaves the changes uncommitted in the card's tree, and stops the card with `question.owner`. Before, the node committed and pushed whatever the answer session left in the tree.

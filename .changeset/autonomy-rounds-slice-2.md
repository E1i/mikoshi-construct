---
'mikoshi-construct': patch
---

The window can now write a round-limit decision "at head" and leave the sha to the bus. When a decision such as `continue-fixes PR #N at head` comes in, the bus replaces `head` with the PR's observed head sha. `allow-merge --head head` works the same way. If the bus has not observed a head for the PR, the decision is refused and the owner's word stays unused. An answer to a review's findings that reports a proof for each finding is now checked against the findings it was given. If any of them is left unproved, the answer is refused and goes again.

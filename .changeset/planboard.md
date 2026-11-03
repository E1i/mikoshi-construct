---
"mikoshi-construct": patch
---

The board reads a release as the cards whose release field names it: merged, in work, review and queue, the remainder of unmerged cards, and the gate as the release's exit criterion, open while the remainder holds a card and due once it is empty. Dropped cards of the release show as one dropped line instead of counting toward the total. `pnpm board --plan <release>` prints the release's plan from the bus, grouped by stage, so plan.md is no longer a second list kept by hand.

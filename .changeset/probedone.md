---
"mikoshi-construct": patch
---

A probe closed by its report is a satisfied dependency for the launch node and for `pnpm task:start` alike: both read one predicate, from the probe's `card.verified` on. A card whose goal is already on `main` closes without a pull request once its witnesses pass on `main`.

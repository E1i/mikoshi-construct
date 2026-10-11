---
"mikoshi-construct": patch
---

internal: `construct intake --admit` and `--move` can hand `card.admitted` and `card.moved` to an event port that a caller inside the repository supplies, after the journal line they write as before. The published CLI supplies none, so its behaviour is unchanged

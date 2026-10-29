---
"mikoshi-construct": patch
---

The bus no longer launches a card behind a card whose pull request is still open. A card with an open pull request keeps its lane and its touches until that pull request is merged or closed, even while it stands stopped on a question or queued again after an amend.

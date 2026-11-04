---
"mikoshi-construct": patch
---

A user factory no longer follows `gh auth switch`. `construct-factory` records the GitHub account of the repository in the keep-alive as `CONSTRUCT_GH_ACCOUNT`: the gh account that started it, or the owner of the `origin` remote when that account cannot push there. Every gh call of a node and every card session runs with `GH_TOKEN` from `gh auth token --user <that account>`, and `doctor --factory` warns under `gh-account` when the active gh account is another one, without stopping the factory. A token gh cannot give for the recorded account fails the call and refuses the card, naming the account, rather than running as the active one.

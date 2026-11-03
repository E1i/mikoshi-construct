---
"mikoshi-construct": patch
---

An answer round now gates only what it changed: the pre-push run takes `--round <head>` and selects tests and lints over the round's own diff from the head it started on, not the whole pull request, and `card.answered` records how long each step of the round took (lease, tree preparation, session start, first turn, gate, push).

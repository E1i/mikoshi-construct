---
"mikoshi-construct": patch
---

The bus witness node no longer closes a card while someone is still working on it. Before, a card whose witnesses already passed on `main` was closed while its launch session still ran. The session then opened a pull request that the bus refused, so the pull request was never reviewed or merged. Now a green witness on `main` closes the card only when no session is running for it and it has no unmerged pull request of its own. Otherwise the green verdict is recorded and the card stays open.

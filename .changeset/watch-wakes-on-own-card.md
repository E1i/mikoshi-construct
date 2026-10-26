---
"mikoshi-construct": patch
---

factory: `miko:watch` now wakes the window on what changes on its own card: a `window.request.done` answering a request this window made (a tree cut that succeeds), every red `witness.recorded` and a green one after red, and a `pr.observed` where CI on a window card's pull request turns green. Before, a successful tree cut, the witness and green CI left the window asleep until someone pointed it at the card.

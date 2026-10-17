---
"mikoshi-construct": minor
---

cli: `construct intake --move <card> --to <dir>` refuses, with exit `1` and nothing moved, when the run has no bus wired to write `card.moved`; the refusal names `pnpm intake --move`. Before, such a run moved the file and wrote only a journal line that no reader of the bus saw. A move to the directory the card already sits in no longer refuses as a taken number: it leaves the file where it is and records the move in the bus. When the bus write throws, the file goes back to where it was.

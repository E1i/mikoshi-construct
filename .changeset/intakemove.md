---
"mikoshi-construct": patch
---

`construct-intake --move` into a launch lane refuses while the bus projection holds an older card body than the latest `card.admitted`, instead of re-admitting that older body and silently reverting an amend. Run it again once the reducer has folded the admission. `--move --dry-run` prints the move and writes nothing: no event in the bus and no file moved.

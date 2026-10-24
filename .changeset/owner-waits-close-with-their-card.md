---
"mikoshi-construct": patch
---

cli: `construct intake --admit` no longer holds a card for the owner when an amend rewords a witness from "non-zero on main" into the "red on main" form: the witness keeps its command and only gains the red-on-main claim, so it is admitted as a tightening rather than refused as a downgrade

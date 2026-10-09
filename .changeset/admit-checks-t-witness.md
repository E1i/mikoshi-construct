---
"mikoshi-construct": patch
---

cli: `construct intake --admit` refuses a card whose witness passes a `-t` that is not a valid regex, naming the witness and the compile error as `--draft` already does, so a card parked earlier or edited by hand can no longer be admitted with a witness that never exits 0

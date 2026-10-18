---
"mikoshi-construct": patch
---

cli: `construct intake --admit` now holds a card it corrects, including one whose merged `depends` it drops, behind a confirmation token and exit 2 until `--confirm <token>` or `--auto-confirm` is given; only an added script companion passes without one, and a person's confirmation is recorded only when `--confirm` was given

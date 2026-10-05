---
"mikoshi-construct": minor
---

cli: `construct intake` parks no card whose corrections a person has not confirmed: it prints them with a token and exits `2`, `--confirm <token>` parks the cards as shown, `--auto-confirm` (off by default) parks them at once, and every parked card gets an `intake` line in `--journal` with its confirmation and corrections.

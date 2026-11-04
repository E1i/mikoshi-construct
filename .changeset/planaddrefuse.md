---
"mikoshi-construct": patch
---

`pnpm bus:request plan --op add` on a release that does not exist or is closed is refused with `release <id> is not open` and writes no `card.planned`. Before, it answered done and the reducer then dropped the event, so the card stayed in no release.

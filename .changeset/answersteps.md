---
"mikoshi-construct": patch
---

Every step of an answer round now writes an `answer.step` bus event with its seconds, so a round that stops or is denied keeps its timings instead of losing them with the `card.answered` it never wrote. A step the round never reached carries null seconds. The gate step now also counts a gate command written `pnpm --dir <tree> …`, the form sessions run, which it used to record as no gate at all.

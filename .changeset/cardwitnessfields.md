---
"mikoshi-construct": patch
---

A card can carry its witnesses and runs as fields: `witnesses: [{"id":"W1","run":"…","test":null,"head":"pass","base":"fail","proves":"…"}]` and `runs: […]`. `construct intake` refuses a field witness with no run, reads `head: exit:N` as that exit, admits a narrowed, moved or negated field witness with no owner decision, and asks for a downgrade by card and id (`#N W1`) instead of the witness text. Cards with prose witnesses work as before.

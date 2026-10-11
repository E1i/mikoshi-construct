---
"mikoshi-construct": patch
---

cli: `construct intake --draft` and `--admit` make a card `owner` when any of its touches is risk R1, whatever `architecture/owner-merges.md` lists, and never lower a card's `owner` decision to `auto`; `--admit` no longer refuses a hand-written `owner` on a card that touches no owner path

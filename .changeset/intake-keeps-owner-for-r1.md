---
"mikoshi-construct": patch
---

cli: `construct intake --draft` and `--admit` make a card `owner` when any of its touches reads risk R1, whatever `architecture/owner-merges.md` lists; the `.changeset/**` companion intake adds reads no R1 and `.changeset/config.json` does, so the card's risk line and its decision read the same risk; they never lower a card's `owner` decision to `auto`; `--admit` no longer refuses a hand-written `owner` on a card that touches no owner path

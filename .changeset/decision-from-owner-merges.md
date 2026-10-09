---
"mikoshi-construct": minor
---

cli: `construct intake --draft` and `--admit` derive a card's decision from `architecture/owner-merges.md` — a touch that meets an owner glob makes it `owner`, otherwise `auto` — and `--admit` refuses a hand-written `owner` on a card that touches no owner path, naming it, until the token it prints confirms `auto`; a repository without that file keeps the card's own decision

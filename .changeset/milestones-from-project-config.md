---
"mikoshi-construct": minor
---

cli: a card's milestone is no longer checked against a list built into the tool. `parseCard` takes the project's milestone list as an argument and refuses a milestone outside it. With no list, it accepts any slug of a-z, 0-9 and '-', or '—', so a card written in another repository parses. A project lists its milestones as the `milestones` array of its construct.json, and `construct intake --admit` and `task:start` hold a card to that list; this repository's own list now lives there.

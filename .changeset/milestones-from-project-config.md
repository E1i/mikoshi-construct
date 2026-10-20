---
"mikoshi-construct": minor
---

cli: a card's milestone is no longer checked against a list built into the tool. `parseCard` takes the project's milestone list as an argument and refuses a milestone outside it. With no list, it accepts any slug of a-z, 0-9 and '-', or '—', so a card written in another repository parses. This repository's own list is now the `milestones` array in its construct.json.

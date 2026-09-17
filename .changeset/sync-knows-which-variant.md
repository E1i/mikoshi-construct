---
"mikoshi-construct": minor
---

`sync` establishes which template variant produced a block before it will write one, and refuses when it cannot.

A file edited by block has two possible sources: the form the construct writes when it creates the file, whose block holds the whole document, and the form it writes into a file that already existed, whose block holds one section of somebody else's. The question of which one applies is really the question of how much of that file is the construct's, and there are three sources of evidence for it. The variant `init` used, recorded in the manifest as it runs, which is exact and only helps repositories materialized from now on. Reconstruction — rendering both variants with the recorded variables and matching the recorded hash — which proves rather than guesses, and rarely matches once the templates have moved on. And the shape of the file, which is good evidence and fails silently, so it may inform what is displayed and never authorise a write.

Where the variant is recorded, the record is taken; where it is provable, it is proved; where it is neither, it is `unknown`, and an unknown path is written in no mode. The report keeps `unknown` apart from `conflict` and says why, because "we cannot tell which variant made this" and "you changed this" lead to different actions, and merged into one line the second reading tells an owner they broke something they never touched.

On a repository materialized before this change the variant is unknown for every block target, so `sync --apply` leaves them alone — the first live run is safe by construction rather than by care.

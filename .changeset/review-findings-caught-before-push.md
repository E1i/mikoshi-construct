---
'mikoshi-construct': patch
---

The pre-push gate now runs the mutations the check catalog predicts the card's witnesses kill, on the files the change touches only, after the tests are green. A surviving mutation turns the gate red and prints one line per survivor (`survived: <file>:<line> <mutation>`), with no logs; when the mutations do not fit under 120 s, or the catalog cannot be read, the gate prints `mutations unchecked: <reason>` and the push goes ahead, leaving them to review. The review prompt now carries the owner's decisions in force bound to the card, and tells the reviewer that a "the card promises X" finding is not given when such a decision allows otherwise.

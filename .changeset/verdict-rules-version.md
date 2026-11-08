---
'mikoshi-construct': patch
---

`review.recorded` carries `rules_version`, the version of the review rules a verdict was given under; a pass carried by a clean update keeps the version of the verdict it carries; and the board can count open pass verdicts under older rules, a record with no version counting as older. Nothing is withdrawn and no stored event is rewritten.

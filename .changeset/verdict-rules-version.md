---
'mikoshi-construct': patch
---

`review.recorded` carries `rules_version`, the version of the review rules a verdict was given under. The version is `REVIEW_RULES_VERSION` in `scripts/nodes/review/review-executor.ts`, pinned to the rules by `REVIEW_RULES_SHA`, the sha-256 of `.claude/agents/review.md` and the review bar line of the reviewer prompt: a change to either is red until the version is raised and the sha re-recorded. It is not `prompt_sha`, which moves with every card body. A pass carried by a clean update keeps the version of the verdict it carries, and the board shows a counter of open pass verdicts under older rules, a record with no version counting as older. Nothing is withdrawn and no stored event is rewritten.

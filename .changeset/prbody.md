---
"mikoshi-construct": patch
---

`pnpm bus:request pr.body --pr <N>` appends the code matrix count line from the card's shift report to the pull request description, so a merge denied for the missing line is queued again under the new description. It is refused with the reason named when the report is absent or holds no count line, or when the description already holds one.

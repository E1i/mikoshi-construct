---
'mikoshi-construct': patch
---

`intake --admit` and `--amend`, from the CLI and from the window's amend request, now refuse a depends that would close a wait cycle. Before binding card A to wait on card B, intake walks what B waits on right now: B's unmerged depends and the card that holds B's launch (an open pull request or a session on an overlapping path, or the head of its lane). If the walk leads back to A, the admission is refused, and the refusal names both cards and the chain, for example `#2047 depends on #2065, and #2065 waits on #2047 (overlap with open PR #1770 on <path>), so neither ever moves`. A depends whose target waits on nothing that leads back is admitted as before, and launch starts the same cards as before. The `open-pr` launch hold now also carries the card of the open pull request. Its reason text is unchanged.

---
"mikoshi-construct": patch
---

`construct attach --upgrade` rewrites only the attach carriers of an attached repository to the installed version and keeps its `.construct` data, the handoff, the bus and `.claude/settings.local.json`. The attach record now carries `attachedVersion`, and `doctor` on an attached repository prints the attached version and the installed one and says when the carriers are stale; a record from before this field reads as unknown.

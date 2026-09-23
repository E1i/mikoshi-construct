---
"mikoshi-construct": patch
---

`construct detach` reads `recordVersion` in `.construct/attach.json` before anything else. A record written by a newer construct is refused with the same line a later `construct.json` gets, naming both versions. A missing or non-integer `recordVersion` is refused with its own reason. Nothing is removed in either case. Records written by this build are version 1 and detach exactly as before; until now, a record of any version was accepted without being checked.

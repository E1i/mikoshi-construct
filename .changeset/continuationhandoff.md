---
"mikoshi-construct": patch
---

A launch session that reaches its context line with no valid handoff no longer stops the card. The bus builds a minimal handoff from the tree diff, the card body and the session's last steps, and continues in a fresh session with no push. The restart limit still bounds it, a `question:` in the report still goes to the owner, and a session that also hit its spend stop still stops. The shift header now states the exact handoff form the bus reads.

---
'mikoshi-construct': patch
---

An answer round no longer resumes a card session that has reached the spend warn of its Eddies limit: beside the per-size context line, the answerer reads the session's spend through the same gauges the session's own Eddies warn uses, and at or past the warn the round starts a fresh session. A round that starts fresh at either warn keeps `.construct/answer-handoff.md` and puts it into its prompt, as the in-task restart does; a resumed round still removes it.

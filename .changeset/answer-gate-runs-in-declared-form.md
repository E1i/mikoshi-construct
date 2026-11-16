---
'mikoshi-construct': patch
---

An answer session is told to run each gate command exactly as declared, from the tree as cwd, with no cd prefix, no pipe and no background run, because the bus records a gate command only by its declared form. A gate command started in the background records no outcome from its start line, so it is never taken as green. When a round ends with no gate decision, the `answer_failed` denial names every command the session ran that contains a declared gate command but not in its declared form, so the cause reads from the answer log without the transcript.

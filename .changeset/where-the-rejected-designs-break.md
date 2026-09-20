---
"mikoshi-construct": patch
---

The ten frozen architect rejections are read by a test that says what they can and cannot establish,
before anything is changed to stop them happening. Most of what they looked like they established
turns out to belong to the log they were recorded in.

All seven payloads the runtime could not parse were cut at exactly 2048 characters, which is the
length that log keeps, while the runtime reported 3436 to 10 293 bytes for the same calls. Any pattern
at that edge is drawn by the recording, so the field the text happens to stop inside is not evidence
about the answer, and between 1388 and 8245 bytes of every payload — the part that would name the
cause — is gone and cannot be recovered.

What sits inside the window is evidence. Every payload begins at `{` with no fence and no prose around
it, not one raw control character survives anywhere in what was kept, and `decision` — the long
free-prose field that the obvious remedy would have bounded — opens the object and closes cleanly at
1255 to 1809 characters, correctly escaped, in all seven. The malformation is therefore somewhere
after `decision`; which of the five fields after it, and whether any of those is clean, this record
cannot say. Every recorded completion stopped with `tool_use` rather than `max_tokens`, and the output
sizes span more than a factor of three with no ceiling they cluster under, which counts against an
answer that ran out of room without settling it.

The three calls that passed no arguments at all are split off as their own class, because they are the
only failure recorded whole: `{}` is the entire input the runtime received. Each spent a turn and then
sent nothing, and each followed at least three attempts already refused, so nothing about them depends
on how long an answer is.

The consequence is an ordering. A measurement of how often the design step fails has to capture the
whole payload, the byte offset at which parsing fails and the reason generation stopped, or it will
reproduce the defect that cost this record its answer: twenty invocations would yield a rate and still
not name a cause. Its first run is diagnostic, not acceptance.

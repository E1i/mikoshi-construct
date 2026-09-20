---
"mikoshi-construct": patch
---

The ten frozen architect rejections are read by a test that says where they break, before anything is
changed to stop them breaking. The answer moves the target.

In all seven payloads the runtime could not parse, `decision` — the long free-prose field, 1255 to
1809 characters of it — closes cleanly and correctly escaped, and the kept window then runs out inside
`contractChanges`, the field after it. Not one raw control character appears anywhere in the window,
and every payload begins at `{` with no fence and no prose wrapped around it. So the obvious remedy, a
length bound on `decision`, would have bounded the one field every single failure got right, and
between 1388 and 8245 bytes of each payload — the rest of `contractChanges` and the four fields after
it — is where the malformation actually has to be.

That part of the record is gone. The journal these came from keeps the first 2048 characters of a tool
input and drops the rest, so what it threw away is exactly the part that would name the cause. The
test asserts only what the window can still establish and the note beside the fixtures says plainly
which hypotheses remain open: a raw newline in a later field, or an answer that stopped mid-object.
This record cannot choose between them.

The consequence is an ordering rather than a fix. Any measurement of how often the design step fails
has to capture the whole payload first, or twenty invocations will produce a rate and still not name a
cause — and a fix chosen before that would be named after a hypothesis that one of these ten
observations already contradicts, a 3436-byte failure being hard to explain by length.

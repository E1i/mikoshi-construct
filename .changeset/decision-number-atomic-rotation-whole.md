---
'mikoshi-construct': patch
---

`decisions:add` no longer gives one number to two decisions or leaves the decisions files in a state that blocks every later decision. Before it writes, it reads the decisions file and its archive again; if another `decisions:add` changed them in the meantime, it plans again on the new state and takes the next free number. A failed add restores only a file that still holds what it wrote, so it no longer erases a decision another add wrote. When older decisions move to the archive, every record of a number moves together, or none of them do, so one number never ends up in both the working file and the archive. `--supersedes D-N` now retires every record of D-N. A number that appears twice is refused with the command that resolves it: `pnpm decisions:add --supersedes D-N "[owner] …"`. Rebuilding the decisions file from the bus keeps both files unchanged if the rebuilt files would fail the check.

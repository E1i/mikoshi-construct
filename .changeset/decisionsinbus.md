---
'mikoshi-construct': patch
---

Owner decisions now live in the bus: the `decisions` table holds each decision's card, term, what it supersedes and its state, in force or archived, and `owner-decisions.md` with its archive is a projection the bus rebuilds. A decision leaves force with no manual step when its card merges or closes and when its term ends, in any factory, with no D-54 in the journal. `pnpm decisions:add` always queues a bus request, a card session sees only its own decisions and the general ones, and no decision is refused for its size any more.

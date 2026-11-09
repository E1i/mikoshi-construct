---
'mikoshi-construct': patch
---

A decision imported from `owner-decisions.md` whose words end it «до <YYYY-MM-DDTHH:MMZ>» now expires at that term. Before, the import read a term only from an `· until` tail, so it left the bus's `until` column empty and the decision stayed in force after its date. The import now takes a single calendar term after «до» as the decision's term: it writes `· until <term>` into the bound text, which fills the column, it leaves out a decision whose term has passed, and `pnpm decisions` no longer prints such a decision to a session. A bare date or two different terms in one decision are left as they were.

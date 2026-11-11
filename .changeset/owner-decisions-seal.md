---
'mikoshi-construct': patch
---

Every reader of the owner decisions goes through `scripts/policy/decisions/`. `intake` reads the right to lower a witness from the decisions in force in the bus, through a decisions port (`BusDecisions`, with `InMemoryDecisions` for tests), and only from a decision the owner recorded with `decisions:add`; a line added to `owner-decisions.md` by hand no longer grants it, because that file is only a projection for people to read. A rebuild of the projection no longer leaves a decision both in `owner-decisions.md` and in its archive. A test now fails when code outside the folder reads the decisions.

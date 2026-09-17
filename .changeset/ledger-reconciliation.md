---
"mikoshi-construct": minor
---

`construct cost` now reads the run ledger and reconciles it against what the runtime exposes, joining on the runtime's own run identifier — which the `/implement` skill step records from here on. Both directions are reported and counted: an entry whose run has no session, and a session with no entry. Neither is an error; they are the two ways a record and a reality drift apart, and seeing the drift is the point. Pairing entries to sessions by time is deliberately not done — that is a guess presented as a finding. Entries written before the key existed are counted as unjoinable, lines that do not parse or lack a declared field are reported with their line number and the exact field path, and a token value of `unknown` is never read as zero, because zero is a number and it would be a lie.

The ledger's declared schema is what the writer can actually produce and no more: the workflow returns aggregate accounting for a run, never a row per agent, so no per-agent field is declared. Declaring a field nobody writes is the same defect as claiming an enforcement nobody performs. `docs/cli.md` says plainly that the ledger is written by a step of a skill and is therefore L0 — a record nobody is obliged to keep.

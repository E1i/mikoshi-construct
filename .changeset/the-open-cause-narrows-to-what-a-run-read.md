---
"mikoshi-construct": patch
---

The open-cause statement now draws the line the evidence supports. Half of the architect failures are
explained, and the boundary is what a run actually read from disk rather than which version
materialized the repository: where the agent definitions still carry the duplicate output contract —
prose restating the runtime schema in a contradicting form, removed from every agent definition in
0.2.0 — the failure is explained, which means a repository materialized before 0.2.0 and never
synced. A tree materialized by 0.1.1, a local patch whose commit message diagnoses exactly that
contradiction, and a sync report putting all three agent definitions in `update` are the evidence;
the patch is cited as evidence only, never as a remedy, since it resolves the contradiction by
dropping the schema, the side decision 0005 forbids.

The four failures recorded on this repository stay unexplained: the prose was removed at 09:59:04Z on
17 September and all four ran after it.

The upgrade guide gains the sentence the whole episode turns on — a defect fixed upstream reaches a
repository only when that repository syncs, so a project left behind keeps running known-fixed
defects with nothing to tell it so, which is what the version-gap line `doctor` prints exists for.

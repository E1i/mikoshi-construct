---
"mikoshi-construct": patch
---

cli: When `red-gate`, `hook`, `construct-tests` and `weakestLink` left `doctor`, the documentation went
on naming them and nothing failed; a reader would have found out before the build did.

The code now owns two lists instead of one. **Current** is derived and never written by hand — the
keys of `DOCTOR_FIELD_FAMILY` plus every claim id and check id the model builder produces. **Retired**
is the new exported list of identifiers this tool has published and no longer uses. Every identifier
the docs and templates name must sit in one of them, so a removal can be described freely while a name
in neither list fails the build. The two are asserted disjoint, which is the list's second and larger
job: a retired name may never come back meaning something else, or every past mention would
retroactively start saying something false.

A mention is a token in code formatting — a key or an `id` value in a fenced JSON result, a
single-backticked cell in the tables that list fields and verdicts — never a word in prose. The English
word "hook" in the L2 level description is not an identifier, and a rule that flagged it would be
demanding edits that make the documentation worse.

**What the scan deliberately does not read.** Only blocks whose shape is a doctor result, and the
field and verdict tables. The manifest and sync-report examples are left alone: their keys —
`manifestVersion`, `strategy`, `counts` — belong to other vocabularies and are in neither list, so
scanning them would have forced exactly the allowlist this design exists to avoid. A test states that
exclusion rather than leaving it to be inferred from a regex.

The gap that leaves is worth naming: no example of `construct.model.json` appears in the docs today,
and if one is added its claim ids will not be scanned. The scan-set assertion catches a scan that
*narrows* — a reworded heading fails — but not one that never widened.

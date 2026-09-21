---
"mikoshi-construct": patch
---

A test guarding the generated release index asserted `order[0]` was `0.8.0` — the newest version on
the day it was written. Every release moves that value, so the check failed on the release after it
shipped, for a reason that had nothing to do with what it was guarding. It now asserts the property it
meant: the list is in descending version order, with more than one entry and a guard against the
assertion holding vacuously.

The same defect the repository keeps recording in other forms — a statement true of the present
standing in for the property — this time inside a test written to enforce a property.

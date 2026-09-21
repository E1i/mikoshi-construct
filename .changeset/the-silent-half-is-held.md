---
"mikoshi-construct": patch
---

The baseline fix in 0.5.1 repaired two things and only one was tested. Files compared against stale
`init` hashes were reported modified, which is what prompted the work; a path recorded **only** by
`sync` was never examined at all, which produced no symptom and so appeared in no test. It shipped
repaired and unheld, free to regress as quietly as it arrived.

It is held now: a path the `init` record never contained is reported missing when it is deleted and
modified when it is edited. Reverting the fix fails all three cases.

The case that asserts silence while the path matches passes under the defect as well, because never
looking is also silent. Only the cases demanding a positive report tell the two apart — which is why
they are the ones that matter here.

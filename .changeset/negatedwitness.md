---
"mikoshi-construct": patch
---

`construct intake --admit` no longer holds an amend for the owner when a witness is rewritten as the negation of the same command with the inverted exit: «`X` exits 1 on head and 0 on base» and «`! X` exits 0 on head and fails on base» state one fact, so the replacement is not a witness downgrade. The witness check reads «exits 1 on head and 0 on base» as a change witness checked by its exit code instead of an invariant that must exit 0. A negated vitest witness now counts as red on the base when its test passes there, and on the head it has to show a failing test, not a crash.

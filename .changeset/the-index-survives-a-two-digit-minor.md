---
"mikoshi-construct": patch
---

The release index asserts that versions run newest first, and the next release is the first with a
two-digit minor — the point at which a string comparison puts `0.10.0` below `0.9.0`. The ordering was
already numeric and the index takes its sequence from `CHANGELOG.md` rather than sorting it, so the
assertion and the data cannot agree on one wrong comparison; both properties are now pinned by tests
instead of being true by accident, with a mutation to a character comparison failing them.

Checked before the release rather than by it, and of the same family as an assertion that pinned the
newest version as a literal: code written while every minor was a single digit, correct up to the day
it is not.

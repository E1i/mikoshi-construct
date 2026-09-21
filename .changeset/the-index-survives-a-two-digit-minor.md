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

**Predicted, so it is not read as a defect.** `0.10.0` is also the first version whose index anchor
carries a two-digit minor. The link is built as `#_0-10-0`, by the rule observed in rendered output for
single-digit minors, and nothing asserts that VitePress slugs the two-digit case the same way —
deliberately, because reasoning about the slugifier is what `docs:anchors` exists to replace. So the
first real check of that anchor happens in the version pull request that introduces `0.10.0`. If it
turns red there, `docs:anchors` is doing its job on the render rather than on an assumption, and the
fix is the anchor, not the gate.

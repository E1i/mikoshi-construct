---
"mikoshi-construct": patch
---

An update task answered `not_behind` now ends as completed instead of failed: it no longer counts toward the failures that stop a card, writes no `card.stopped`, and the update node does not ask GitHub again for the same head. The `policy.denied` that records the answer stays.

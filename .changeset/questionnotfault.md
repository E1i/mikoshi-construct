---
"mikoshi-construct": patch
---

A card whose session ends with no pull request and a plain question is no longer stopped as a fault. It waits on the question, and it starts again once the owner closes every question it asked. A session that ends with no pull request and no question is still a fault.

---
"mikoshi-construct": patch
---

Finding the tests that cover a card's touches reads each file at most once: `TestCoverage` keeps every text it has read, and a test is read once and checked against every touched name. On a large pull request the review plan step no longer spends minutes re-reading the same tests. The covering tests found are unchanged.

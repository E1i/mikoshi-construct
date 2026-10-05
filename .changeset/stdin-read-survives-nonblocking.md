---
"mikoshi-construct": patch
---

cli: `construct intake --taken -` and `construct board --prs -` wait for a slow producer on stdin instead of refusing with EAGAIN.

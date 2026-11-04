---
"mikoshi-construct": patch
---

`construct intake` now reads a `creates` entry ending in `/**` as covering every path under it, so a card that creates a new package no longer files its own witness as unclear or a touch under that package as missing.

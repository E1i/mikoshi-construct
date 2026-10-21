---
"mikoshi-construct": patch
---

`construct intake` now marks a witness unclear when one of its commands names `origin/main`, which moves while a run is in progress. The check now lives in the intake check, and the ghosts preflight imports it from there.

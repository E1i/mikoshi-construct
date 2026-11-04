---
"mikoshi-construct": patch
---

The merge queue updates one green pull request at a time: a pull request the bus just updated keeps the turn until it merges, turns red, is parked or 30 minutes pass, and a pull request of documents no test reads merges without an update.

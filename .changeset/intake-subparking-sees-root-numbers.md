---
"mikoshi-construct": patch
---

cli: `construct intake` with `--parking` set to a subdirectory of the parking assigns a number no card already holds: the cards parked in the parking root and in every subdirectory of it count as taken, and so does every number an `intake` line in the journal names, not only the files of the `--parking` directory.

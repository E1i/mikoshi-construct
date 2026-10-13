---
"mikoshi-construct": patch
---

Without a connected bus — the published CLI wires none — `construct intake` counts every journal line whatever its time, so a merge line written after `2026-10-12T17:04Z` removes a `depends` or `blocks` again; the cutoff applies only when a caller wires a bus in.

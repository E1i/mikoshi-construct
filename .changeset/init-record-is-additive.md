---
"mikoshi-construct": patch
---

**ENGRAM EXTENDED — a second `construct init` adds to the record instead of replacing it.**

`files` is the protocol of what the construct has ever written into a repository, not a snapshot of
the last run. A re-init rewrote it with only the paths that run wrote, so every path the first run
wrote and this one skipped as "exists, review manually" silently left the record. Measured on a
scratch tree: a manifest carrying 43 paths, re-inited, then read by `construct sync` as 4 `keep` and
39 `conflict`, with nothing in the tree changed. Discovery provenance went the same way — the branch
that exists to evidence authorship was replaced with ten `unknown` markers.

`buildManifest` now takes `previous` as a required input. When there is one, `files` and `variants`
merge, `construct`, `createdAt`, the discovery record and the sync record stay the earlier run's
values, and only this run's configuration — preset, AI target, review, harness, contracts, vars —
comes from this run, because a second `init` is how a Cursor target or code review gets added.

**Both replacements are audible.** A re-init prints how many records it carried over and how many it
added, and names every variable whose value changed with both values, because `vars` is the one
place the merge still replaces a decision: a different `--name` moves `projectName` while the
recorded hashes were taken with the old one. Nothing is forbidden; it is said out loud.

Recorded as decision 0013, which supersedes the one sentence in 0006 that read the other way, and
states the consequence that arrives later: after a preset change the paths the old preset wrote stay
in `files` and read as `orphaned`, and cleaning them out would be this defect returning under a
tidier name.

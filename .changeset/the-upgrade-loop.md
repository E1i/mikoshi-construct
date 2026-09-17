---
"mikoshi-construct": patch
---

**The docs say what a repository does when a new version lands.**

`sync` is one step of four, and the CLI reference now writes the loop out: report, `--apply`, your
own harness, `doctor`. Each step answers a different question, and the note that matters most is
that `sync` does not answer the harness's — the construct writes what it can prove it owns, which
is not a claim that your project still builds.

Also stated: a sync never erases discovery, because the filled body of every marker is carried
across a block replacement; what the report leaves for the owner, class by class; that the version
in `construct.json` is frozen by design and the pending count is the number that moves; and that
re-running `init` is not an upgrade path. That last one is measured, not asserted — a tree whose
manifest carried 43 paths was re-`init`ed, and the next `sync` read 4 `keep` and 39 `conflict`,
because `init` rewrites the record with only the files that run wrote.

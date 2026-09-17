---
"mikoshi-construct": patch
---

**A green release run now has to mean the version is installable.**

Publishing 0.3.0 ended green — `Successfully published`, a git tag, a GitHub release — with nothing on
the registry. The version had gone into npm's staged-publish state, which a stage-only trusted
publisher produces by design and which no CI token can approve; the next run exposed it with `409
Cannot publish over previously staged version`. The pipeline had reported a success the world did not
contain.

A separate `Release verification` workflow now asks the registry about the version in `package.json`
after every release, and can be re-run on its own once a human approves a staged version — re-running
the release itself would only publish again and fail on the 409.

It answers with three outcomes rather than a boolean, because the rule this release is built on
applies to its own guards: `installable`, `absent`, and `unreachable` for a request that could not be
made. A network error is never read as a missing version. And when a version is `absent` the message
names both worlds it could mean — a staged publish awaiting approval, or a publish that failed while
reporting success — because CI cannot tell them apart and picking one would be the same defect again.

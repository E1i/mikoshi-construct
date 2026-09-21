---
"mikoshi-construct": minor
---

A construct.json from a later build is reported, not silently normalised

`upgradeManifest` read any `manifestVersion` whatever its value: a manifest from a later build was
treated as one from an earlier build, its unfamiliar branches discarded and `manifestVersion`
rewritten down. Decision 0009 settled the backward direction and left this one open.

Now a `manifestVersion` above what the binary understands throws a named error carrying both
numbers, and every command that reads the manifest — `doctor`, `sync`, `init`, and `cost` where the
environment does not already name the runtime — reports one line naming the version found, the
version understood, and that a newer CLI is needed. Nothing is read and nothing is written.

**This does not help anyone already running an older binary.** A published 0.1.1 will keep throwing
on a v4 manifest; nothing here reaches it. The change is prospective: it makes the next shape change
a reportable state instead of a second stack trace, and decision 0022 says so rather than reading as
a repair of the crash that prompted it.

---
"mikoshi-construct": patch
---

`doctor` compared every path against the frozen `init` record and ignored everything `sync` had
recorded since, so on any repository that has run `sync --apply` it reported the files sync had just
written as modified. Found on a real tree, not a fixture: seven fabricated entries sitting beside
nineteen genuine ones, with nothing in the output telling them apart, and one more added by every
future sync.

`construct.json` holds two records on purpose — the `init` record is frozen by decision 0006, and the
sync record carries what has been written since. The latest recorded state for a path is the first
overlaid by the second, which is what `recordedShas` has always returned and what `sync` itself
reads. `doctor` simply did not use it. That was visible in the output before it was visible in the
code: `versionGap` reached the sync record through `replay` while `modifiedFiles` did not, one
sibling backed and the other bare.

The same defect was in two more places. `uncollectedTests` looked for the runner config and
enumerated recorded test files in the init record alone, so anything sync added was invisible to it.
And `init` counted the records it carried over from an existing `construct.json` without the sync
half, under-reporting what it kept and over-reporting what it added.

Three occurrences make it structural rather than a bug to fix again, so the shared boundary is now
enforced: reading `manifest.files` directly anywhere under `src/` fails lint, with `src/manifest.ts`
the single exemption, since it is the file that defines what the two records mean.

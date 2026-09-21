---
"mikoshi-construct": patch
---

The upgrading guide knows about the model, and about a manifest it cannot read

`docs/guide/upgrading.md` described a four-step loop that has never written a `construct.model.json`,
so a repository carried forward from before 0.5.0 followed the page exactly and still had none. The
page now carries the one upgrade case that needs `init`, why it is safe — the record is additive, and
a construct claim is written only where its evidence holds, so the run cannot invent enforcement the
tree does not have — and the fact that `doctor` says all of this itself.

It also warns that the list of claims will be **shorter** than before rather than longer, in 0.5.0's
own words: shorter not because less is checked, but because less of it was pretending. And it carries
the one failure upgrading produces on its own, a stale CLI meeting a manifest from a later build,
which now stops with a named line instead of a stack trace.

Written from a run of the sequence, in order, against a tree materialized by an early 0.1.x release
and carried forward with no model — structurally that tree and no other. `sync`, `sync --apply`,
`doctor` before and after, `init`, and the later-manifest case were each run and their output is what
the page quotes. `pnpm run quality` is the one step in the page not exercised there, because that
tree has no installed toolchain; it is unchanged from before.

No change to `sync`, `init` or any template.

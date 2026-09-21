---
"mikoshi-construct": patch
---

The documentation site stops at a version that no longer exists. `docs/release-notes/` carried three
hand-written pages and the `Releases` nav link pointed at 0.5.0, while the changelog had already
recorded nine more releases — the content existed and was simply never rendered, on the page a reader
lands on when the tool did not work for them.

A generated index at `docs/release-notes/` now lists every version `CHANGELOG.md` carries, newest
first, rendered by `pnpm release-notes:render` and committed the way the composition diagrams are. A
release with a hand-written note — 0.5.0 and its upgrade sequence, which no changeset roll-up would
produce — is linked rather than repeated, so hand-written notes stay the better thing where a release
needs one.

The floor is held by two tests rather than by remembering: one fails when the committed index drifts
from the changelog, the other reads the versions from `CHANGELOG.md` and the wiring from the real
VitePress config and fails in both directions — a version added to the changelog and wired nowhere,
and wiring removed for a version that exists.

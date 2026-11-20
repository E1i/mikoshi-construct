---
'mikoshi-construct': patch
---

The GitHub release of a version is created from a summary within a fixed budget, not from the whole CHANGELOG section. The release workflow stops changesets/action from creating the release and creates it after the publish from `scripts/release-notes/release-body.ts`: the first sentence of every changeset with its pull request, under 100000 characters, linking the full CHANGELOG entry at the tag. The version pull request renders the same body in CI and is red when it is over the budget, before the merge publishes anything.

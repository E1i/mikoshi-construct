---
"mikoshi-construct": patch
---

The release index is generated from `CHANGELOG.md`, and `changeset version` writes `CHANGELOG.md` —
so every version pull request bumped the changelog, left the generated page behind, and failed its own
harness on the gate added to keep that page current. The gate was right and the pipeline was missing a
step: `version-packages` now runs the renderer after `changeset version`, so the page is regenerated
by the same step that invalidates it.

A test resolves the version script the release workflow names, follows it through `package.json`, and
fails when that chain no longer reaches the renderer — the state every release was in until now.

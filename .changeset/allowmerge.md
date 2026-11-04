---
"mikoshi-construct": patch
---

A repository that already has `.claude/settings.json` now gets the scan allowlist: `init` and `sync --apply` add `WebFetch`, `WebSearch` and `mcp__context7` to `permissions.allow` beside the repository's own entries, and a second run changes nothing. `Edit(/**)` and `Write(/**)` are not merged, so write permission in an existing repository stays as it was. A repository without these rules now reads as `update` in `sync`, and a `permissions` or `permissions.allow` of the wrong shape reads as `conflict` and is left byte for byte.

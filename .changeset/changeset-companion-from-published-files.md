---
"mikoshi-construct": patch
---

cli: `construct intake` and `construct intake --admit` add a changeset to a card's touches only for a path the package publishes, read from the `files` field of the repository's `package.json` — a `templates/` path directly and a `src/` path when `dist` is published — so a touch under `scripts/` gets none, and a repository with no `files` field gets no changeset companion

---
"mikoshi-construct": patch
---

The files the mikoshi factory reads in a repository — the `brief`, `review` and `scan` agents, the `probe` skill, `.claude/eddies.json`, `.claude/settings.json`, `architecture/owner-merges.md` and the hook scripts under `scripts/construct/` — are now one list in code, and a test fails when the factory names a file `init` does not carry. `construct sync --apply` brings a repository initialised before them up to date, and now also appends the factory hooks to a `.claude/settings.json` that lacks them, keeping every entry and key already there. `construct doctor` goes red when the construct carried some of them and one is missing, and says to run `construct sync --apply`; a repository whose record holds none of them is not read as run by the factory.

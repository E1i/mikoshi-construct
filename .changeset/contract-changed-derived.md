---
"mikoshi-construct": minor
---

templates: the ladder derives `contractChanged` instead of asking the harness agent to judge it. The harness agent reports `changedFiles` — `git diff --name-only HEAD` plus untracked files, verbatim — and the VERDICT schema no longer has a `contractChanged` field. `implement.workflow.mjs` sets the result's `contractChanged` when a changed file equals, exactly, one of `args.harness.contractPaths`, and returns `changedFiles` beside it. The `/implement` skill fills `contractPaths` by reading `contracts.path` and `contracts.types` from `construct.json` and a `Contract paths:` line from `CLAUDE.md`; `.construct/attach.json` records no contract paths, so an attached repository names them in that line.
